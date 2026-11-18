//! Contención de procesos por tab: agrupa al proceso lanzado **y a toda su descendencia**
//! para poder matarlos juntos al cerrar la tab.
//!
//! # Por qué no alcanza con matar al proceso que lanzamos
//!
//! `portable-pty` mata solo al hijo directo: `SIGHUP` a un pid en unix (lib.rs:315) y
//! `TerminateProcess` en Windows (lib.rs:295). Ninguno de los dos toca a los nietos. Un
//! agente que levanta `npm run dev` deja el servidor corriendo cuando se cierra la tab.
//!
//! En unix hay una red de seguridad del kernel que tapa el caso más común: cuando muere el
//! líder de sesión, el terminal cuelga y el grupo en primer plano recibe `SIGHUP`. Medido
//! con `examples/orphan_probe.rs`, eso alcanza para un `sleep 600 &` normal e incluso para
//! uno con `nohup` — pero **no** para un proceso que se va a su propia sesión con `setsid`,
//! que sobrevive. `killpg` tampoco lo alcanza, justamente porque ya no está en ese grupo.
//! En Windows no existe siquiera esa red.
//!
//! # Cómo se resuelve en cada plataforma
//!
//! | Plataforma | Mecanismo | Alcanza a la descendencia completa |
//! |---|---|---|
//! | Linux | cgroup v2 propio por tab + `cgroup.kill` | sí, la pertenencia se hereda y no se puede escapar |
//! | Windows | Job Object + `TerminateJobObject` | sí, ídem |
//! | macOS | recorrido del árbol por `ppid` | best-effort (ver más abajo) |
//!
//! macOS no tiene ningún equivalente a cgroups ni a los Job Objects, así que ahí se
//! enumera el árbol por `ppid` y se mata de las hojas hacia la raíz. Es best-effort a
//! propósito: un proceso que ya fue reasignado a `init` pierde el vínculo con su padre y
//! el recorrido no lo encuentra. Se usa el mismo camino como respaldo en Linux si los
//! cgroups no están disponibles (contenedor sin delegación, cgroup v1, etc.).
//!
//! El `Drop` mata el grupo, así que cubre por igual los dos caminos por los que una sesión
//! sale del registry: el cierre explícito (`pty_kill`) y la muerte natural del proceso.
//!
//! # Qué habilita esto hacia adelante
//!
//! Con el grupo en su lugar, un proceso envoltorio deja de ser un problema. Eso importa
//! para los pre-comandos de lanzamiento (`conda activate` y compañía), que obligan a
//! delegar en un shell: en unix el `exec` final hace que el envoltorio se convierta en el
//! agente y conserve su pid, pero **Windows no tiene `exec`**, así que ahí el agente queda
//! sí o sí como hijo del `cmd` que lo lanzó. Sin el Job Object, matar la tab dejaría vivo
//! al agente; con él, el envoltorio es indistinto.

/// Lo mínimo que hace falta de un proceso recién lanzado para poder adoptarlo.
///
/// Existe porque los procesos de la app vienen de dos lados: las tabs los lanzan con
/// `portable-pty` (necesitan una terminal de verdad) y los agentes headless con
/// `tokio::process` (necesitan el stdout redirigido, no un PTY). Las dos clases de hijo
/// tienen que quedar contenidas igual, y de las dos se usa exactamente lo mismo: el pid en
/// unix, el handle en Windows.
pub trait Adoptable {
    #[cfg_attr(windows, expect(dead_code, reason = "Windows adopts the process by handle; Unix uses its pid"))]
    fn pid(&self) -> Option<u32>;
    #[cfg(windows)]
    fn raw_handle(&self) -> Option<std::os::windows::io::RawHandle>;
}

/// El hijo de una tab: `portable-pty` lo entrega como objeto de trait.
impl Adoptable for dyn portable_pty::Child + Send + Sync {
    fn pid(&self) -> Option<u32> {
        self.process_id()
    }
    #[cfg(windows)]
    fn raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        self.as_raw_handle()
    }
}

/// El hijo de un agente headless: `tokio::process`, con el stdout redirigido.
impl Adoptable for tokio::process::Child {
    fn pid(&self) -> Option<u32> {
        self.id()
    }
    #[cfg(windows)]
    fn raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        self.raw_handle()
    }
}

/// Un proceso pelado. Lo usa el test de contención, que ejercita `adopt` sin montar un
/// pty entero.
impl Adoptable for std::process::Child {
    fn pid(&self) -> Option<u32> {
        Some(self.id())
    }
    #[cfg(windows)]
    fn raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        use std::os::windows::io::AsRawHandle;
        Some(AsRawHandle::as_raw_handle(self))
    }
}

/// Contenedor de ciclo de vida de una tab.
///
/// Se crea **antes** de lanzar el proceso, para que exista ya cuando el hijo empiece a
/// tener descendencia propia.
pub struct ProcessGroup {
    pub(crate) imp: imp::Group,
}

impl ProcessGroup {
    const DEFAULT_GRACE: std::time::Duration = std::time::Duration::from_secs(2);
    /// `id` es el del PTY; solo se usa para darle un nombre legible al grupo.
    pub fn new(id: u32) -> Self {
        Self { imp: imp::create(id) }
    }

    /// Contêiner usado por sessões ACP que nascem como líderes de um grupo Unix próprio.
    /// Não cria cgroup no Linux: o encerramento escalado deve alcançar só o grupo Unix.
    pub fn new_acp() -> Self {
        Self { imp: imp::create_acp() }
    }

    /// Mete al proceso recién lanzado en el grupo. Sus hijos futuros entran solos: tanto
    /// los cgroups como los Job Objects se heredan al crear un proceso.
    ///
    /// Hay una carrera inevitable acá: el proceso ya está corriendo cuando lo adoptamos, y
    /// en teoría podría haber lanzado un hijo en ese intervalo. Es la misma ventana que
    /// aceptan VS Code y node, y no se puede cerrar sin `CREATE_SUSPENDED`/`posix_spawn`
    /// propios, que `portable-pty` no expone.
    pub fn adopt<C: Adoptable + ?Sized>(&mut self, child: &C) {
        imp::adopt(&mut self.imp, child);
    }

    /// Mata todo lo que quede adentro. Idempotente: se llama explícitamente al cerrar una
    /// tab y otra vez desde `Drop`.
    pub fn kill_all(&mut self) {
        kill_groups(std::slice::from_mut(self), Self::DEFAULT_GRACE);
    }

    /// ¿Hay detrás un mecanismo del kernel del que la descendencia no pueda escaparse?
    ///
    /// `false` significa que solo queda el recorrido por `ppid`, que por diseño no alcanza
    /// a un proceso ya reasignado a `init` (ver la tabla de arriba). Es siempre `false` en
    /// macOS, y en Linux cuando no se pudo crear el cgroup — un contenedor sin delegación,
    /// cgroup v1, o un entorno donde no tenemos permiso, como los runners de CI.
    ///
    /// Se consulta **después** de `adopt`: el cgroup puede existir y aun así no dejarnos
    /// mover procesos, y eso recién se sabe al intentarlo.
    ///
    /// Hoy solo lo usa el test de fin a fin, para no afirmar una garantía que el entorno
    /// donde corre no da.
    #[cfg(test)]
    #[cfg_attr(not(target_os = "linux"), expect(dead_code, reason = "only Linux tests query this capability"))]
    pub(crate) fn is_escape_proof(&self) -> bool {
        imp::is_escape_proof(&self.imp)
    }
}

/// Encerra grupos juntos para que a janela de graça não se multiplique pela quantidade de
/// sessões. No Unix, todos recebem HUP/TERM antes de começar o prazo compartilhado.
pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> std::time::Instant;
    fn sleep(&self, duration: std::time::Duration);
}

pub(crate) struct SystemClock;

const POST_KILL_REAP: std::time::Duration = std::time::Duration::from_millis(150);

impl Clock for SystemClock {
    fn now(&self) -> std::time::Instant {
        std::time::Instant::now()
    }
    fn sleep(&self, duration: std::time::Duration) {
        std::thread::sleep(duration);
    }
}

pub(crate) fn kill_groups(groups: &mut [ProcessGroup], grace: std::time::Duration) {
    kill_groups_with(groups, grace, &SystemClock);
}

pub(crate) fn kill_groups_with(
    groups: &mut [ProcessGroup],
    grace: std::time::Duration,
    clock: &dyn Clock,
) {
    if groups.is_empty() {
        return;
    }
    for group in groups.iter_mut() {
        imp::begin_shutdown(&mut group.imp);
    }
    let deadline = clock.now() + grace;
    while clock.now() < deadline
        && !groups.iter().all(|group| imp::shutdown_complete(&group.imp))
    {
        let remaining = deadline.saturating_duration_since(clock.now());
        clock.sleep(remaining.min(std::time::Duration::from_millis(15)));
    }
    let needs_force = !groups.iter().all(|group| imp::shutdown_complete(&group.imp));
    if needs_force {
        for group in groups.iter_mut() {
            if !imp::shutdown_complete(&group.imp) {
                imp::force_shutdown(&mut group.imp);
            }
        }
        let reap_deadline = clock.now() + POST_KILL_REAP;
        while clock.now() < reap_deadline
            && !groups.iter().all(|group| imp::shutdown_complete(&group.imp))
        {
            let remaining = reap_deadline.saturating_duration_since(clock.now());
            clock.sleep(remaining.min(std::time::Duration::from_millis(15)));
        }
    }
    for group in groups.iter_mut() {
        imp::finish_shutdown(&mut group.imp);
    }
}

pub(crate) async fn kill_groups_async(groups: Vec<ProcessGroup>, grace: std::time::Duration) {
    kill_groups_async_with(groups, grace, std::sync::Arc::new(SystemClock)).await;
}

pub(crate) async fn kill_groups_async_with(
    mut groups: Vec<ProcessGroup>,
    grace: std::time::Duration,
    clock: std::sync::Arc<dyn Clock>,
) {
    let _ = tokio::task::spawn_blocking(move || kill_groups_with(&mut groups, grace, clock.as_ref())).await;
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// Como o encerramento escalado fala com o sistema: sinalizar um grupo Unix e esperar o prazo.
/// Em produção é `Reais`; os testes trocam por um falso, com relógio falso.
#[cfg(unix)]
pub(crate) trait Sinais {
    /// `pgid` positivo; a implementação envia ao grupo todo, sem fotografar PIDs.
    fn enviar_grupo(&self, pgid: i32, sinal: libc::c_int) -> bool;
    fn esperar(&self, prazo: std::time::Duration);
}

#[cfg(unix)]
pub(crate) struct Reais;

#[cfg(unix)]
impl Sinais for Reais {
    fn enviar_grupo(&self, pgid: i32, sinal: libc::c_int) -> bool {
        unsafe { libc::killpg(pgid, sinal) == 0 }
    }
    fn esperar(&self, prazo: std::time::Duration) {
        std::thread::sleep(prazo);
    }
}

/// O encerramento escalado de um grupo (só para sessões ACP; as abas seguem com `kill_all`, que manda SIGHUP). Em
/// duas fases: `ProcessGroup::encerrar_escalando` manda SIGTERM ao grupo Unix agora, e `concluir` manda SIGKILL ao
/// grupo depois do prazo. O spawn ACP cria o processo líder com `process_group(0)`. Descendentes que chamam `setsid`
/// saem do grupo e não são alcançados. Quem chama conta o prazo numa thread de fundo.
pub struct Escalada {
    /// PGID positivo do processo líder; vazio no Windows.
    #[cfg_attr(not(unix), allow(dead_code))]
    pgid: Option<i32>,
}

impl ProcessGroup {
    /// SIGTERM agora ao grupo Unix. Devolve o plano do SIGKILL.
    #[cfg(unix)]
    pub fn encerrar_escalando(&mut self) -> Escalada {
        self.encerrar_escalando_com(&Reais)
    }

    #[cfg(unix)]
    pub(crate) fn encerrar_escalando_com<S: Sinais>(&mut self, sinais: &S) -> Escalada {
        let (raiz, _cgroup) = imp::tirar_alvos(&mut self.imp);
        let pgid = raiz.and_then(|pid| i32::try_from(pid).ok()).filter(|pgid| *pgid > 0);
        if let Some(pgid) = pgid {
            sinais.enviar_grupo(pgid, libc::SIGTERM);
        }
        Escalada { pgid }
    }

    /// No Windows o job já é o encerramento imediato: não há sinal intermediário.
    #[cfg(not(unix))]
    pub fn encerrar_escalando(&mut self) -> Escalada {
        self.kill_all();
        Escalada { pgid: None }
    }
}

impl Escalada {
    /// Depois do prazo. Retorna `true` se o SIGKILL encontrou membros no grupo.
    #[cfg(unix)]
    pub fn concluir(self, prazo: std::time::Duration) -> bool {
        self.concluir_com(&Reais, prazo)
    }

    #[cfg(not(unix))]
    pub fn concluir(self, _prazo: std::time::Duration) -> bool {
        false
    }

    #[cfg(unix)]
    pub(crate) fn concluir_com<S: Sinais>(self, sinais: &S, prazo: std::time::Duration) -> bool {
        sinais.esperar(prazo);
        self.pgid.is_some_and(|pgid| sinais.enviar_grupo(pgid, libc::SIGKILL))
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Linux — cgroup v2
// ─────────────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
pub(crate) mod imp {
    use std::path::PathBuf;

    pub struct Group {
        /// `None` si no se pudo crear el cgroup; ahí se cae al respaldo por `ppid`.
        dir: Option<PathBuf>,
        leader: Option<u32>,
        leader_identity: Option<super::unix_tree::ProcessIdentity>,
        pending: Vec<super::unix_tree::ProcessIdentity>,
    }

    /// El cgroup de la propia app, leído de `/proc/self/cgroup`. En cgroup v2 hay una sola
    /// línea con el formato `0::/ruta/relativa/a/la/raiz`.
    fn own_cgroup() -> Option<PathBuf> {
        let raw = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        let rel = raw.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
        Some(PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
    }

    pub fn create(id: u32) -> Group {
        // Se crea un cgroup HIJO del de la app y no un hermano: así queda colgado del
        // scope de systemd de esta instancia y desaparece solo si la app muere sin
        // limpiar. No hace falta tocar `cgroup.subtree_control` porque `cgroup.kill` es un
        // archivo del core, no de un controlador — y sin controladores habilitados no
        // aplica la restricción de "nada de procesos en nodos internos", así que los hilos
        // de la app pueden seguir viviendo en el cgroup padre.
        let dir = own_cgroup()
            .map(|own| own.join(format!("cc-tab-{id}")))
            .filter(|d| std::fs::create_dir(d).is_ok());
        Group { dir, leader: None, leader_identity: None, pending: Vec::new() }
    }

    #[cfg(test)]
    pub fn set_identity_for_test(g: &mut Group, identity: super::unix_tree::ProcessIdentity) {
        g.leader = Some(identity.pid);
        g.leader_identity = Some(identity);
    }

    /// Sessões ACP usam `killpg`; não criam um cgroup que conteria processos com `setsid`.
    pub fn create_acp() -> Group {
        Group { dir: None, leader: None, leader_identity: None, pending: Vec::new() }
    }

    pub fn adopt<C: super::Adoptable + ?Sized>(g: &mut Group, child: &C) {
        let Some(pid) = child.pid() else { return };
        g.leader = Some(pid);
        g.leader_identity = super::unix_tree::capture_at_adopt(pid);
        if let Some(dir) = &g.dir {
            // Mover el pid al cgroup arrastra al proceso entero; lo que nazca de él
            // después hereda la pertenencia y no puede salirse.
            if std::fs::write(dir.join("cgroup.procs"), pid.to_string()).is_err() {
                // El cgroup existe pero no nos deja mover procesos: no sirve de nada
                // conservarlo. Queda el recorrido por `ppid` como único mecanismo.
                let _ = std::fs::remove_dir(dir);
                g.dir = None;
            }
        }
    }

    #[cfg(test)]
    pub fn is_escape_proof(g: &Group) -> bool {
        g.dir.is_some()
    }

    /// Tira o líder e o cgroup do grupo, para o encerramento escalado (ver `Escalada`).
    pub fn tirar_alvos(g: &mut Group) -> (Option<u32>, Option<PathBuf>) {
        (g.leader.take(), g.dir.take())
    }

    pub fn begin_shutdown(g: &mut Group) {
        // Los dos mecanismos se usan juntos, y en este orden, porque cada uno tapa el
        // agujero del otro:
        //
        //  - El recorrido por `ppid` alcanza a lo que nació en la ventana de adopción
        //    (entre el spawn y el momento en que movemos al líder al cgroup), que quedó
        //    afuera del cgroup. Medido: `sh -c 'setsid sleep 30 & ...'` lanza el nieto
        //    antes de que lleguemos a adoptarlo.
        //  - El cgroup alcanza a lo que el recorrido no puede ver: procesos ya reasignados
        //    a `init`, o nacidos mientras el recorrido estaba a mitad de camino.
        //
        // Además el recorrido manda SIGHUP y no SIGKILL, así que un agente bien portado
        // alcanza a cerrar sus archivos — importa, porque las TUIs escriben su transcript
        // al salir y de ahí sale el título de la sesión.
        if g.pending.is_empty() {
            if let (Some(pid), Some(identity)) = (g.leader, g.leader_identity.as_ref()) {
                g.pending = super::unix_tree::begin_tree_shutdown(pid, identity);
            }
        }
    }

    pub fn shutdown_complete(g: &Group) -> bool {
        let cgroup_empty = g.dir.as_ref().is_none_or(|dir| {
            std::fs::read_to_string(dir.join("cgroup.procs"))
                .map(|s| s.trim().is_empty())
                .unwrap_or(false)
        });
        let tracked_pids_dead = g.pending.iter().all(|p| !super::unix_tree::is_alive(p));
        cgroup_empty && tracked_pids_dead
    }

    pub fn force_shutdown(g: &mut Group) {
        if let (Some(pid), Some(identity)) = (g.leader, g.leader_identity.as_ref()) {
            let rescanned = super::unix_tree::rescan_tree(pid, identity, &g.pending);
            super::unix_tree::extend_unique(&mut g.pending, rescanned);
        }
        super::unix_tree::signal_victims(&g.pending, libc::SIGKILL);
        if let Some(dir) = &g.dir {
            // cgroup.kill cobre também descendentes que saíram do grupo de sessão.
            let still_populated = std::fs::read_to_string(dir.join("cgroup.procs"))
                .map(|s| !s.trim().is_empty())
                .unwrap_or(true);
            if still_populated {
                let _ = std::fs::write(dir.join("cgroup.kill"), "1");
            }
        }
    }

    pub fn finish_shutdown(g: &mut Group) {
        g.pending.clear();
        if let Some(dir) = g.dir.take() {
            // El rmdir solo funciona con el cgroup ya vacío; si algo quedó, se lo lleva la
            // muerte del scope de systemd de la app.
            let _ = std::fs::remove_dir(&dir);
        }
        g.leader = None;
        g.leader_identity = None;
    }

    #[cfg(test)]
    pub fn usa_cgroup(g: &Group) -> bool {
        g.dir.is_some()
    }

    #[cfg(test)]
    pub fn dir_de(g: &Group) -> Option<PathBuf> {
        g.dir.clone()
    }

    #[cfg(test)]
    mod tests {
        use crate::terminal::containment::ProcessGroup;

        #[test]
        fn cgroup_populado_impede_encerrar_antes_da_arvore_tratada() {
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn");
            let mut group = ProcessGroup::new(9_003);
            group.adopt(&child);
            if !super::usa_cgroup(&group.imp) {
                let _ = child.kill();
                let _ = child.wait();
                eprintln!("omitido: cgroup v2 delegado indisponível neste ambiente");
                return;
            }

            // A varredura pode estar vazia enquanto o cgroup ainda contém um processo.
            group.imp.pending.clear();
            assert!(!super::shutdown_complete(&group.imp));
            group.kill_all();
            assert!(child.try_wait().unwrap().is_some());
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// macOS — recorrido del árbol por ppid
// ─────────────────────────────────────────────────────────────────────────────────────
#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) mod imp {
    pub struct Group {
        leader: Option<u32>,
        leader_identity: Option<super::unix_tree::ProcessIdentity>,
        pending: Vec<super::unix_tree::ProcessIdentity>,
    }

    pub fn create(_id: u32) -> Group {
        Group { leader: None, leader_identity: None, pending: Vec::new() }
    }

    #[cfg(test)]
    pub fn set_identity_for_test(g: &mut Group, identity: super::unix_tree::ProcessIdentity) {
        g.leader = Some(identity.pid);
        g.leader_identity = Some(identity);
    }

    pub fn create_acp() -> Group {
        create(0)
    }

    pub fn adopt<C: super::Adoptable + ?Sized>(g: &mut Group, child: &C) {
        g.leader = child.pid();
        g.leader_identity = g.leader.and_then(super::unix_tree::capture_at_adopt);
    }

    #[cfg(test)]
    /// Nunca: acá el único mecanismo es el recorrido por `ppid`, que es best-effort.
    pub fn is_escape_proof(_g: &Group) -> bool {
        false
    }

    /// Tira o líder do grupo, para o encerramento escalado (ver `Escalada`). No macOS não há cgroup.
    pub fn tirar_alvos(g: &mut Group) -> (Option<u32>, Option<std::path::PathBuf>) {
        (g.leader.take(), None)
    }

    pub fn begin_shutdown(g: &mut Group) {
        if g.pending.is_empty() {
            if let (Some(pid), Some(identity)) = (g.leader, g.leader_identity.as_ref()) {
                g.pending = super::unix_tree::begin_tree_shutdown(pid, identity);
            }
        }
    }

    pub fn shutdown_complete(g: &Group) -> bool {
        g.pending.iter().all(|p| !super::unix_tree::is_alive(p))
    }

    pub fn force_shutdown(g: &mut Group) {
        if let (Some(pid), Some(identity)) = (g.leader, g.leader_identity.as_ref()) {
            let rescanned = super::unix_tree::rescan_tree(pid, identity, &g.pending);
            super::unix_tree::extend_unique(&mut g.pending, rescanned);
        }
        super::unix_tree::signal_victims(&g.pending, libc::SIGKILL);
    }

    pub fn finish_shutdown(g: &mut Group) {
        g.pending.clear();
        g.leader = None;
        g.leader_identity = None;
    }
}

/// Respaldo para unix sin cgroups: se enumera el árbol por `ppid` y se mata de las hojas
/// hacia la raíz, para que un padre no alcance a lanzar hijos nuevos mientras cae.
///
/// El recorrido tiene que hacerse **antes** de matar a nadie: una vez que el padre muere,
/// el kernel reasigna a sus hijos y el vínculo que los identificaba se pierde.
#[cfg(unix)]
pub(crate) mod unix_tree {
    use std::collections::HashMap;

    #[derive(Clone, Debug)]
    struct ProcessInfo {
        pid: u32,
        ppid: u32,
        pgid: u32,
        start_time: u64,
        alive: bool,
    }

    #[derive(Debug)]
    pub(crate) struct ProcessIdentity {
        pub(crate) pid: u32,
        pub(crate) start_time: u64,
        pub(crate) pgid: u32,
        #[cfg(target_os = "linux")]
        pub(crate) pidfd: Option<std::sync::Arc<std::os::fd::OwnedFd>>,
    }

    #[cfg(target_os = "linux")]
    fn read_process(pid: u32) -> Option<ProcessInfo> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        Some(ProcessInfo {
            pid,
            ppid: fields.get(1)?.parse().ok()?,
            pgid: fields.get(2)?.parse().ok()?,
            start_time: fields.get(19)?.parse().ok()?,
            alive: !matches!(*fields.first()?, "Z" | "X"),
        })
    }

    #[cfg(target_os = "macos")]
    fn read_process(pid: u32) -> Option<ProcessInfo> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let read = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
                size,
            )
        };
        (read == size).then_some(ProcessInfo {
            pid: info.pbi_pid,
            ppid: info.pbi_ppid,
            pgid: info.pbi_pgid,
            start_time: info.pbi_start_tvsec.saturating_mul(1_000_000)
                .saturating_add(info.pbi_start_tvusec),
            alive: info.pbi_status != libc::SZOMB,
        })
    }

    #[cfg(target_os = "linux")]
    fn snapshot() -> Vec<ProcessInfo> {
        std::fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(read_process)
            .collect()
    }

    #[cfg(target_os = "macos")]
    fn snapshot() -> Vec<ProcessInfo> {
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0_i32; count as usize + 32];
        let bytes = (pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
        let copied = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if copied <= 0 {
            return Vec::new();
        }
        pids.into_iter()
            .take(copied as usize)
            .filter(|pid| *pid > 0)
            .filter_map(|pid| read_process(pid as u32))
            .collect()
    }

    #[cfg(target_os = "linux")]
    fn open_pidfd(pid: u32) -> Option<std::sync::Arc<std::os::fd::OwnedFd>> {
        use std::os::fd::FromRawFd;
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0_u32) };
        (fd >= 0).then(|| std::sync::Arc::new(unsafe {
            std::os::fd::OwnedFd::from_raw_fd(fd as i32)
        }))
    }

    pub(crate) fn capture_identity(pid: u32) -> Option<ProcessIdentity> {
        let first = read_process(pid)?;
        #[cfg(target_os = "linux")]
        let pidfd = open_pidfd(pid);
        let confirmed = read_process(pid)?;
        if first.start_time != confirmed.start_time {
            return None;
        }
        Some(ProcessIdentity {
            pid,
            start_time: confirmed.start_time,
            pgid: confirmed.pgid,
            #[cfg(target_os = "linux")]
            pidfd,
        })
    }

    fn capture_snapshot_identity(pid: u32, expected_start_time: u64) -> Option<ProcessIdentity> {
        let identity = capture_identity(pid)?;
        (identity.start_time == expected_start_time).then_some(identity)
    }

    pub(crate) fn capture_at_adopt(pid: u32) -> Option<ProcessIdentity> {
        capture_identity(pid).or_else(|| capture_identity(pid))
    }

    fn is_same_process(victim: &ProcessIdentity) -> bool {
        read_process(victim.pid).is_some_and(|process| process.start_time == victim.start_time)
    }

    pub(crate) fn is_alive(victim: &ProcessIdentity) -> bool {
        read_process(victim.pid)
            .is_some_and(|process| process.alive && process.start_time == victim.start_time)
    }

    fn send_signal(victim: &ProcessIdentity, signal: i32) {
        #[cfg(target_os = "linux")]
        if let Some(pidfd) = &victim.pidfd {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    pidfd.as_raw_fd(),
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0_u32,
                );
            }
            return;
        }
        // Sem pidfd (kernel antigo ou syscall indisponível), valida a identidade de novo
        // imediatamente antes do sinal. macOS não oferece uma primitiva equivalente.
        if is_same_process(victim) {
            unsafe { libc::kill(victim.pid as libc::pid_t, signal); }
        }
    }

    pub(crate) fn signal_victims(victims: &[ProcessIdentity], signal: i32) {
        for victim in victims {
            send_signal(victim, signal);
        }
    }

    fn tree(
        root: u32,
        identity: &ProcessIdentity,
        pending: &[ProcessIdentity],
        procs: &[ProcessInfo],
    ) -> Vec<(u32, u64)> {
        let by_pid: HashMap<u32, &ProcessInfo> = procs.iter().map(|process| (process.pid, process)).collect();
        let mut found = Vec::new();
        if by_pid.get(&root).is_some_and(|process| process.start_time == identity.start_time) {
            found.push((root, identity.start_time));
        }
        for survivor in pending {
            if by_pid.get(&survivor.pid).is_some_and(|process| process.start_time == survivor.start_time)
                && !found.iter().any(|(pid, _)| *pid == survivor.pid)
            {
                found.push((survivor.pid, survivor.start_time));
            }
        }
        let mut index = 0;
        while index < found.len() {
            let (parent, parent_start) = found[index];
            for process in procs {
                if process.ppid == parent
                    && process.start_time >= parent_start
                    && !found.iter().any(|(pid, _)| *pid == process.pid)
                {
                    found.push((process.pid, process.start_time));
                }
            }
            index += 1;
        }
        #[cfg(target_os = "macos")]
        if by_pid.get(&root).is_some_and(|process| process.start_time == identity.start_time)
            && identity.pgid == root
            && identity.pgid > 1
            && identity.pgid as i32 != unsafe { libc::getpgrp() }
        {
            // No macOS, complementa PPID com os membros do grupo de processos do líder:
            // alcança filhos que foram reparentados durante a janela de graça.
            for process in procs {
                if process.pgid == identity.pgid
                    && process.start_time >= identity.start_time
                    && !found.iter().any(|(pid, _)| *pid == process.pid)
                {
                    found.push((process.pid, process.start_time));
                }
            }
        }
        if found.is_empty() {
            return Vec::new();
        }
        found
    }

    pub(crate) fn rescan_tree(
        root: u32,
        identity: &ProcessIdentity,
        pending: &[ProcessIdentity],
    ) -> Vec<ProcessIdentity> {
        let processes = snapshot();
        let mut pids = tree(root, identity, pending, &processes);
        pids.reverse();
        pids.into_iter()
            .filter_map(|(pid, start_time)| capture_snapshot_identity(pid, start_time))
            .collect()
    }

    pub(crate) fn extend_unique(pending: &mut Vec<ProcessIdentity>, rescanned: Vec<ProcessIdentity>) {
        for process in rescanned {
            if !pending.iter().any(|known| known.pid == process.pid && known.start_time == process.start_time) {
                pending.push(process);
            }
        }
    }

    fn signal_wave(
        victims: &[ProcessIdentity],
        grouped_pgid: Option<u32>,
        signal: i32,
        mut signal_group: impl FnMut(u32, i32) -> bool,
        mut signal_process: impl FnMut(&ProcessIdentity, i32),
    ) {
        let group_signalled = grouped_pgid.is_some_and(|pgid| signal_group(pgid, signal));
        for victim in victims {
            if Some(victim.pgid) != grouped_pgid || !group_signalled {
                signal_process(victim, signal);
            }
        }
    }

    pub(crate) fn begin_tree_shutdown(
        root: u32,
        identity: &ProcessIdentity,
    ) -> Vec<ProcessIdentity> {
        let victims = rescan_tree(root, identity, &[]);
        let grouped_pgid = victims.iter().find(|process| process.pid == root).and_then(|leader| {
            let pgid = leader.pgid;
            (pgid == leader.pid
                && pgid > 1
                && pgid as i32 != unsafe { libc::getpgrp() }
                && is_alive(leader))
            .then_some(pgid)
        });
        for signal in [libc::SIGHUP, libc::SIGTERM] {
            let live_group = grouped_pgid.filter(|_| {
                victims.iter().find(|process| process.pid == root).is_some_and(is_alive)
            });
            signal_wave(
                &victims,
                live_group,
                signal,
                |pgid, signal| unsafe { libc::killpg(pgid as i32, signal) == 0 },
                send_signal,
            );
        }
        victims
    }

    #[cfg(test)]
    mod tests {
        use super::{
            ProcessIdentity, ProcessInfo, capture_identity, capture_snapshot_identity,
            rescan_tree, signal_victims, signal_wave, tree,
        };

        #[test]
        fn falha_ao_sinalizar_o_grupo_repassa_a_onda_aos_pids_validados() {
            let leader_pid = u32::MAX;
            let victims = [
                ProcessIdentity {
                    pid: leader_pid,
                    start_time: 1,
                    pgid: leader_pid,
                    #[cfg(target_os = "linux")]
                    pidfd: None,
                },
                ProcessIdentity {
                    pid: leader_pid - 1,
                    start_time: 2,
                    pgid: leader_pid,
                    #[cfg(target_os = "linux")]
                    pidfd: None,
                },
                ProcessIdentity {
                    pid: leader_pid - 2,
                    start_time: 3,
                    pgid: leader_pid - 2,
                    #[cfg(target_os = "linux")]
                    pidfd: None,
                },
            ];
            let mut group_calls = Vec::new();
            let mut process_calls = Vec::new();

            signal_wave(
                &victims,
                Some(leader_pid),
                libc::SIGTERM,
                |pgid, signal| {
                    group_calls.push((pgid, signal));
                    false
                },
                |process, signal| process_calls.push((process.pid, signal)),
            );

            assert_eq!(group_calls, [(leader_pid, libc::SIGTERM)]);
            assert_eq!(
                process_calls,
                [
                    (leader_pid, libc::SIGTERM),
                    (leader_pid - 1, libc::SIGTERM),
                    (leader_pid - 2, libc::SIGTERM),
                ]
            );
        }

        #[test]
        fn identidade_diferente_bloqueia_sigkill_por_pid() {
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn");
            let mut identity = capture_identity(child.id()).expect("identidade do filho");
            let snapshot_start_time = identity.start_time;
            assert!(capture_snapshot_identity(child.id(), snapshot_start_time).is_some());
            let recycled_pid = capture_snapshot_identity(child.id(), snapshot_start_time.saturating_add(1));
            assert!(recycled_pid.is_none(), "um PID divergente do snapshot não vira vítima");
            if let Some(victim) = recycled_pid.as_ref() {
                signal_victims(std::slice::from_ref(victim), libc::SIGKILL);
            }
            assert!(child.try_wait().unwrap().is_none(), "o PID do snapshot não deve receber sinal");
            identity.start_time = identity.start_time.saturating_add(1);
            #[cfg(target_os = "linux")]
            {
                // Força o caminho de fallback por start_time; o pidfd continua sendo a
                // prova preferida quando a identidade capturada está íntegra.
                identity.pidfd = None;
            }

            signal_victims(std::slice::from_ref(&identity), libc::SIGKILL);
            assert!(child.try_wait().unwrap().is_none(), "o PID não bate com a identidade capturada");
            let _ = child.kill();
            let _ = child.wait();
        }

        #[test]
        fn revarredura_usa_sobrevivente_quando_o_lider_ja_foi_colhido() {
            let root = 100_000;
            let survivor = ProcessIdentity {
                pid: root + 1,
                start_time: 10,
                pgid: root,
                #[cfg(target_os = "linux")]
                pidfd: None,
            };
            let identity = ProcessIdentity {
                pid: root,
                start_time: 1,
                pgid: root,
                #[cfg(target_os = "linux")]
                pidfd: None,
            };
            let snapshot = [
                ProcessInfo { pid: root + 1, ppid: 1, pgid: root, start_time: 10, alive: true },
                ProcessInfo { pid: root + 2, ppid: root + 1, pgid: root, start_time: 11, alive: true },
            ];

            let found = tree(root, &identity, std::slice::from_ref(&survivor), &snapshot);
            assert!(found.contains(&(root + 2, 11)), "o descendente novo precisa ser descoberto pelo sobrevivente");
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn rodada2_item1_lider_reciclado_nao_autoriza_varrer_o_pgid_antigo() {
            let root = 100_000;
            let identity = ProcessIdentity {
                pid: root,
                start_time: 1,
                pgid: root,
            };
            // O PID root agora pertence a outro grupo. O membro abaixo continua no PGID
            // antigo, mas sua identidade também não foi comprovada pela adoção original.
            let snapshot = [
                ProcessInfo { pid: root, ppid: 1, pgid: root + 50, start_time: 10, alive: true },
                ProcessInfo { pid: root + 1, ppid: 1, pgid: root, start_time: 11, alive: true },
            ];

            let found = tree(root, &identity, &[], &snapshot);
            assert!(found.is_empty(), "líder reciclado invalida todo o PGID registrado");
        }

        #[test]
        fn identidade_adulterada_nao_emite_killpg() {
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn");
            let mut identity = capture_identity(child.id()).expect("identidade do filho");
            identity.start_time = identity.start_time.saturating_add(1);
            #[cfg(target_os = "linux")]
            { identity.pidfd = None; }

            let victims = rescan_tree(child.id(), &identity, &[]);
            let grouped_pgid = victims.iter()
                .find(|victim| victim.pid == child.id())
                .filter(|leader| leader.pid == identity.pgid)
                .map(|leader| leader.pgid);
            let mut group_calls = Vec::new();
            signal_wave(&victims, grouped_pgid, libc::SIGKILL,
                |pgid, signal| { group_calls.push((pgid, signal)); true },
                |_, _| {});

            assert!(group_calls.is_empty(), "identidade divergente não autoriza killpg");
            assert!(child.try_wait().unwrap().is_none(), "o alvo precisa continuar vivo");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(all(test, unix))]
mod group_tests {
    use super::{ProcessGroup, imp, kill_groups_with, unix_tree::capture_identity};
    use std::time::Duration;

    #[test]
    fn kill_groups_nao_emite_killpg_para_identidade_adulterada() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn");
        let mut identity = capture_identity(child.id()).expect("identidade do processo");
        identity.start_time = identity.start_time.saturating_add(1);
        identity.pgid = identity.pid;
        #[cfg(target_os = "linux")]
        { identity.pidfd = None; }

        let mut group = ProcessGroup::new(91_025);
        imp::set_identity_for_test(&mut group.imp, identity);
        kill_groups_with(std::slice::from_mut(&mut group), Duration::ZERO, &super::SystemClock);

        assert!(child.try_wait().unwrap().is_none(), "grupo adulterado não deve sinalizar o PID");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rodada2_item3_start_time_antigo_nao_mata_lider_do_pgid_reciclado() {
        use std::os::unix::process::CommandExt;
        use std::sync::Mutex;
        use std::time::Instant;

        struct StepClock(Mutex<Instant>);
        impl super::Clock for StepClock {
            fn now(&self) -> Instant { *self.0.lock().unwrap() }
            fn sleep(&self, duration: Duration) {
                let mut now = self.0.lock().unwrap();
                *now += duration;
            }
        }

        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exec sleep 30"]);
        command.process_group(0);
        let mut child = command.spawn().expect("spawn do líder de grupo");
        let mut identity = capture_identity(child.id()).expect("identidade do líder");
        assert_eq!(identity.pgid, child.id(), "o filho precisa liderar seu grupo");
        assert!(identity.start_time > 1, "start_time real deve permitir o cenário de PID reciclado");
        identity.start_time -= 1;
        let mut group = ProcessGroup::new(91_026);
        imp::set_identity_for_test(&mut group.imp, identity);

        let clock = StepClock(Mutex::new(Instant::now()));
        kill_groups_with(
            std::slice::from_mut(&mut group),
            Duration::from_millis(30),
            &clock,
        );

        let result = child.try_wait().expect("consultar filho");
        if result.is_some() {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(result.is_none(), "líder com identidade divergente recebeu HUP/TERM ou SIGKILL");
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// El test de arriba pasaría igual si el cgroup no funcionara, porque el recorrido por
/// `ppid` solo ya alcanza para ese caso. Estos verifican el mecanismo de Linux por
/// separado, para que no quede como código muerto que nadie ejercita.
// ─────────────────────────────────────────────────────────────────────────────────────
// Windows — Job Object
// ─────────────────────────────────────────────────────────────────────────────────────
#[cfg(windows)]
pub(crate) mod imp {
    use std::os::windows::io::RawHandle;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject, JobObjectBasicAccountingInformation,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Group {
        job: HANDLE,
        /// O pid do filho, para o plano B (`taskkill /T`) quando o Job Object não ficou com ele.
        pid: Option<u32>,
        /// `true` só se o `AssignProcessToJobObject` deu certo. Sem isso, `TerminateJobObject` não alcança nada.
        atribuido: bool,
    }

    // El handle del job es propiedad exclusiva de esta struct y solo se toca detrás del
    // mutex del registry; nada lo comparte entre hilos por su cuenta.
    unsafe impl Send for Group {}

    pub fn create(_id: u32) -> Group {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if !job.is_null() {
            // KILL_ON_JOB_CLOSE es lo que hace que esto sobreviva a un cierre que NO pase
            // por nuestro código: si matan ADE AGS desde el Administrador de tareas o
            // panica, el kernel cierra igual los handles del proceso muerto, y al cerrarse
            // el último handle del job se lleva a todos sus miembros.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
        }
        Group { job, pid: None, atribuido: false }
    }

    pub fn create_acp() -> Group {
        create(0)
    }

    pub fn adopt<C: super::Adoptable + ?Sized>(g: &mut Group, child: &C) {
        g.pid = child.pid();
        if g.job.is_null() {
            eprintln!("[containment] sem Job Object: o encerramento do processo vai pelo taskkill /T");
            return;
        }
        // Se usa el handle que ya tiene `portable-pty` en vez de reabrir por pid: evita la
        // carrera de que ese pid haya sido reutilizado, que en Windows pasa seguido.
        let Some(handle) = child.raw_handle() else {
            eprintln!("[containment] o processo não expôs o handle: o encerramento vai pelo taskkill /T");
            return;
        };
        // El retorno antes se ignoraba: sin el proceso en el job, `TerminateJobObject` no mataba nada y la
        // descendencia quedaba viva. Ahora el error queda registrado y el encerramento cae al taskkill.
        let ok = unsafe { AssignProcessToJobObject(g.job, handle as RawHandle as HANDLE) };
        if ok != 0 {
            g.atribuido = true;
        } else {
            let erro = unsafe { GetLastError() };
            eprintln!("[containment] AssignProcessToJobObject falhou (erro {erro}): o encerramento vai pelo taskkill /T");
        }
    }

    #[cfg(test)]
    pub fn is_escape_proof(g: &Group) -> bool {
        g.atribuido
    }

    pub fn begin_shutdown(_g: &mut Group) {}

    pub fn shutdown_complete(g: &Group) -> bool {
        if !g.atribuido && g.pid.is_some() {
            return false;
        }
        if g.job.is_null() {
            return g.pid.is_none();
        }
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                g.job,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        ok != 0 && accounting.ActiveProcesses == 0
    }

    pub fn force_shutdown(g: &mut Group) {
        if !g.job.is_null() {
            unsafe { TerminateJobObject(g.job, 1); }
        }
        if !g.atribuido {
            if let Some(pid) = g.pid.take() {
                matar_arvore_por_pid(pid);
            }
        }
    }

    pub fn finish_shutdown(g: &mut Group) {
        if !g.job.is_null() {
            unsafe { CloseHandle(g.job); }
            g.job = std::ptr::null_mut();
        }
    }

    /// `taskkill /T /F` mata o processo e os filhos que ainda estão ligados a ele. É o plano B quando o Job Object não
    /// ficou com o processo. Com prazo, pelo helper de processos do app.
    fn matar_arvore_por_pid(pid: u32) {
        let mut cmd = crate::util::spawn::hidden_command("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
        if let Err(erro) = crate::util::spawn::output(&mut cmd, Duration::from_secs(5)) {
            eprintln!("[containment] taskkill /T do pid {pid} falhou: {erro}");
        }
    }

    #[cfg(test)]
    pub fn usa_job(g: &Group) -> bool {
        !g.job.is_null()
    }
}
