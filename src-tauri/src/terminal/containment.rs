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
        kill_all_groups(std::iter::once(self));
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
pub(crate) fn kill_all_groups<'a>(groups: impl IntoIterator<Item = &'a mut ProcessGroup>) {
    kill_all_groups_with_grace(groups, std::time::Duration::from_secs(2));
}

pub(crate) fn kill_all_groups_with_grace<'a>(
    groups: impl IntoIterator<Item = &'a mut ProcessGroup>,
    grace: std::time::Duration,
) {
    let mut groups: Vec<_> = groups.into_iter().collect();
    #[cfg(all(unix, not(target_os = "linux")))]
    if groups.len() == 1 {
        imp::kill_all_with_grace(&mut groups[0].imp, grace);
        return;
    }
    #[cfg(unix)]
    {
        for group in &mut groups {
            imp::begin_shutdown(&mut group.imp);
        }
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline
            && groups.iter().any(|group| !imp::shutdown_complete(&group.imp))
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        for group in &mut groups {
            imp::force_shutdown(&mut group.imp);
        }
    }
    #[cfg(windows)]
    let _ = grace;
    #[cfg(windows)]
    for group in &mut groups {
        imp::kill_all(&mut group.imp);
    }
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
        g.leader_identity = super::unix_tree::capture_identity(pid);
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
        if let Some(pid) = g.leader.take() {
            g.pending = super::unix_tree::begin_tree_shutdown(pid, g.leader_identity.take());
        }
    }

    pub fn shutdown_complete(g: &Group) -> bool {
        let cgroup_empty = g.dir.as_ref().is_some_and(|dir| {
            std::fs::read_to_string(dir.join("cgroup.procs"))
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
        });
        cgroup_empty || g.pending.iter().all(|p| !super::unix_tree::is_same_process(p))
    }

    pub fn force_shutdown(g: &mut Group) {
        super::unix_tree::signal_victims(&g.pending, libc::SIGKILL);
        g.pending.clear();
        let Some(dir) = g.dir.take() else { return };
        // cgroup.kill cobre também descendentes que saíram do grupo de sessão.
        let still_populated = std::fs::read_to_string(dir.join("cgroup.procs"))
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if still_populated {
            let _ = std::fs::write(dir.join("cgroup.kill"), "1");
        }
        // El rmdir solo funciona con el cgroup ya vacío; si algo quedó, se lo lleva la
        // muerte del scope de systemd de la app.
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(test)]
    pub fn usa_cgroup(g: &Group) -> bool {
        g.dir.is_some()
    }

    #[cfg(test)]
    pub fn dir_de(g: &Group) -> Option<PathBuf> {
        g.dir.clone()
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
        g.leader_identity = g.leader.and_then(super::unix_tree::capture_identity);
    }

    #[cfg(test)]
    /// Nunca: acá el único mecanismo es el recorrido por `ppid`, que es best-effort.
    pub fn is_escape_proof(_g: &Group) -> bool {
        false
    }

    pub fn begin_shutdown(g: &mut Group) {
        if let Some(pid) = g.leader.take() {
            g.pending = super::unix_tree::begin_tree_shutdown(pid, g.leader_identity.take());
        }
    }

    pub fn shutdown_complete(g: &Group) -> bool {
        g.pending.iter().all(|p| !super::unix_tree::is_same_process(p))
    }

    pub fn force_shutdown(g: &mut Group) {
        super::unix_tree::signal_victims(&g.pending, libc::SIGKILL);
        g.pending.clear();
    }

    pub fn kill_all_with_grace(g: &mut Group, grace: std::time::Duration) {
        if let Some(pid) = g.leader.take() {
            super::unix_tree::kill_tree(pid, g.leader_identity.take(), grace);
        }
    }
}

/// Respaldo para unix sin cgroups: se enumera el árbol por `ppid` y se mata de las hojas
/// hacia la raíz, para que un padre no alcance a lanzar hijos nuevos mientras cae.
///
/// El recorrido tiene que hacerse **antes** de matar a nadie: una vez que el padre muere,
/// el kernel reasigna a sus hijos y el vínculo que los identificaba se pierde.
#[cfg(unix)]
pub(crate) mod unix_tree {
    #[derive(Clone, Copy, Debug)]
    pub(crate) struct ProcessIdentity {
        pub(crate) pid: u32,
        pub(crate) start_time: u64,
        pub(crate) pgid: Option<u32>,
    }

    /// `(pid, ppid)` de todos los procesos del sistema. Se usa `ps` y no `/proc` porque
    /// este camino existe sobre todo para macOS, que no tiene `/proc`.
    fn snapshot() -> Vec<(u32, u32)> {
        let out = match crate::util::spawn::hidden_command("ps").args(["-eo", "pid=,ppid="]).output() {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
            })
            .collect()
    }

    /// Descendientes de `root`, en orden de profundidad creciente (la raíz no va incluida).
    pub(crate) fn descendants(root: u32, procs: &[(u32, u32)]) -> Vec<u32> {
        let mut found = vec![root];
        let mut i = 0;
        while i < found.len() {
            let parent = found[i];
            for (pid, ppid) in procs {
                // El guardia contra `found.contains` evita un bucle infinito si `ps`
                // devuelve un ciclo por reutilización de pids entre lecturas.
                if *ppid == parent && !found.contains(pid) {
                    found.push(*pid);
                }
            }
            i += 1;
        }
        found.remove(0);
        found
    }

    #[cfg(target_os = "linux")]
    fn process_info(pid: u32) -> Option<(u64, u32)> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm pode conter espaços e parênteses; os campos começam após o último ')'.
        let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        Some((fields.get(19)?.parse().ok()?, fields.get(2)?.parse().ok()?))
    }

    #[cfg(target_os = "macos")]
    fn process_info(pid: u32) -> Option<(u64, u32)> {
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
        (read == size).then_some((
            (info.pbi_start_tvsec as u64)
                .saturating_mul(1_000_000)
                .saturating_add(info.pbi_start_tvusec as u64),
            info.pbi_pgid as u32,
        ))
    }

    pub(crate) fn capture_identity(pid: u32) -> Option<ProcessIdentity> {
        let (start_time, pgid) = process_info(pid)?;
        Some(ProcessIdentity { pid, start_time, pgid: Some(pgid) })
    }

    pub(crate) fn is_same_process(victim: &ProcessIdentity) -> bool {
        process_info(victim.pid).is_some_and(|(start, _)| start == victim.start_time)
    }

    pub(crate) fn signal_if_same(victim: &ProcessIdentity, signal: i32) {
        if is_same_process(victim) {
            unsafe { libc::kill(victim.pid as i32, signal); }
        }
    }

    pub(crate) fn signal_victims(victims: &[ProcessIdentity], signal: i32) {
        if signal == libc::SIGKILL {
            for victim in victims {
                signal_if_same(victim, signal);
            }
            return;
        }
        let leader = victims.iter().find(|victim| victim.pgid == Some(victim.pid));
        let grouped_pgid = leader.and_then(|leader| {
            if !is_same_process(leader) { return None; }
            let pgid = leader.pgid?;
            if !victims
                .iter()
                .filter(|victim| victim.pgid == Some(pgid))
                .all(is_same_process)
            {
                return None;
            }
            (unsafe { libc::killpg(pgid as i32, signal) } == 0).then_some(pgid)
        });
        for victim in victims {
            if victim.pgid != grouped_pgid {
                signal_if_same(victim, signal);
            }
        }
    }

    pub(crate) fn begin_tree_shutdown(
        root: u32,
        root_identity: Option<ProcessIdentity>,
    ) -> Vec<ProcessIdentity> {
        let procs = snapshot();
        let mut victims = descendants(root, &procs);
        victims.reverse(); // hojas primeiro
        victims.push(root);
        let identities: Vec<_> = victims
            .into_iter()
            .filter_map(|pid| {
                if pid == root { root_identity }
                else { capture_identity(pid) }
            })
            .filter(is_same_process)
            .collect();
        signal_victims(&identities, libc::SIGHUP);
        signal_victims(&identities, libc::SIGTERM);
        identities
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn kill_tree(
        root: u32,
        root_identity: Option<ProcessIdentity>,
        grace: std::time::Duration,
    ) {
        let victims = begin_tree_shutdown(root, root_identity);
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline && victims.iter().any(is_same_process) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        signal_victims(&victims, libc::SIGKILL);
    }

    /// Espera uma janela injetável após TERM e só força os processos que continuam vivos.
    #[cfg(test)]
    pub(crate) fn terminate_with_grace(
        victims: &[ProcessIdentity],
        grace: std::time::Duration,
        mut signal: impl FnMut(u32, i32),
        wait: impl FnOnce(std::time::Duration),
        mut current_start_time: impl FnMut(u32) -> Option<u64>,
    ) {
        for victim in victims {
            if current_start_time(victim.pid) == Some(victim.start_time) {
                signal(victim.pid, libc::SIGTERM);
            }
        }
        wait(grace);
        for victim in victims {
            if current_start_time(victim.pid) == Some(victim.start_time) {
                signal(victim.pid, libc::SIGKILL);
            }
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
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
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

    pub fn kill_all(g: &mut Group) {
        if g.job.is_null() {
            return;
        }
        unsafe {
            TerminateJobObject(g.job, 1);
            CloseHandle(g.job);
        }
        g.job = std::ptr::null_mut();
    }

    #[cfg(test)]
    pub fn usa_job(g: &Group) -> bool {
        !g.job.is_null()
    }
}
