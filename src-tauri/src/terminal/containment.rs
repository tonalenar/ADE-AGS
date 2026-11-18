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
    for group in groups.iter_mut() {
        imp::force_shutdown(&mut group.imp);
    }
    let reap_deadline = clock.now() + POST_KILL_REAP;
    while clock.now() < reap_deadline
        && !groups.iter().all(|group| imp::shutdown_complete(&group.imp))
    {
        let remaining = reap_deadline.saturating_duration_since(clock.now());
        clock.sleep(remaining.min(std::time::Duration::from_millis(15)));
    }
    for group in groups.iter_mut() {
        imp::finish_shutdown(&mut group.imp);
    }
}

pub(crate) async fn kill_groups_async(mut groups: Vec<ProcessGroup>, grace: std::time::Duration) {
    let _ = tokio::task::spawn_blocking(move || kill_groups(&mut groups, grace)).await;
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill_all();
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
            g.pending.extend(super::unix_tree::rescan_tree(pid, identity));
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
        use super::super::super::ProcessGroup;

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

    pub fn adopt<C: super::Adoptable + ?Sized>(g: &mut Group, child: &C) {
        g.leader = child.pid();
        g.leader_identity = g.leader.and_then(super::unix_tree::capture_at_adopt);
    }

    #[cfg(test)]
    /// Nunca: acá el único mecanismo es el recorrido por `ppid`, que es best-effort.
    pub fn is_escape_proof(_g: &Group) -> bool {
        false
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
            g.pending.extend(super::unix_tree::rescan_tree(pid, identity));
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
        pidfd: Option<std::sync::Arc<std::os::fd::OwnedFd>>,
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

    fn tree(root: u32, identity: &ProcessIdentity, procs: &[ProcessInfo]) -> Vec<u32> {
        let by_pid: HashMap<u32, &ProcessInfo> = procs.iter().map(|process| (process.pid, process)).collect();
        let Some(root_info) = by_pid.get(&root).filter(|process| {
            process.start_time == identity.start_time
        }) else {
            return Vec::new();
        };
        let mut found = vec![(root, root_info.start_time)];
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
        if root_info.pgid == root
            && root_info.pgid > 1
            && root_info.pgid as i32 != unsafe { libc::getpgrp() }
        {
            // No macOS, complementa PPID com os membros do grupo de processos do líder:
            // alcança filhos que foram reparentados durante a janela de graça.
            for process in procs {
                if process.pgid == root_info.pgid
                    && process.start_time >= root_info.start_time
                    && !found.iter().any(|(pid, _)| *pid == process.pid)
                {
                    found.push((process.pid, process.start_time));
                }
            }
        }
        found.into_iter().map(|(pid, _)| pid).collect()
    }

    pub(crate) fn rescan_tree(root: u32, identity: &ProcessIdentity) -> Vec<ProcessIdentity> {
        let processes = snapshot();
        let mut pids = tree(root, identity, &processes);
        pids.reverse();
        pids.into_iter().filter_map(capture_identity).collect()
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
        let victims = rescan_tree(root, identity);
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
        use super::{ProcessIdentity, capture_identity, signal_victims, signal_wave};

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
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject, JobObjectBasicAccountingInformation,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Group {
        job: HANDLE,
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
        Group { job }
    }

    pub fn adopt<C: super::Adoptable + ?Sized>(g: &mut Group, child: &C) {
        if g.job.is_null() {
            return;
        }
        // Se usa el handle que ya tiene `portable-pty` en vez de reabrir por pid: evita la
        // carrera de que ese pid haya sido reutilizado, que en Windows pasa seguido.
        let Some(handle) = child.raw_handle() else { return };
        unsafe {
            AssignProcessToJobObject(g.job, handle as RawHandle as HANDLE);
        }
    }

    #[cfg(test)]
    pub fn is_escape_proof(g: &Group) -> bool {
        !g.job.is_null()
    }

    pub fn begin_shutdown(_g: &mut Group) {}

    pub fn shutdown_complete(g: &Group) -> bool {
        if g.job.is_null() {
            return true;
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
        if g.job.is_null() {
            return;
        }
        unsafe {
            TerminateJobObject(g.job, 1);
            CloseHandle(g.job);
        }
        g.job = std::ptr::null_mut();
    }

    pub fn finish_shutdown(_g: &mut Group) {}

    #[cfg(test)]
    pub fn usa_job(g: &Group) -> bool {
        !g.job.is_null()
    }
}
