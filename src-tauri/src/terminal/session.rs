//! Sessão de terminal emitida pelo app.
//!
//! Cada PTY de uma aba recebe um token (`ADE_SESSION`) que só o processo
//! daquele terminal herda, e o PID desse processo fica registrado junto.
//! A CLI manda o token. O servidor, no socket de credencial, lê o PID de
//! quem conectou e só aceita se esse PID for o processo do PTY ou um
//! descendente. Token e ancestralidade juntos: copiar o token de outro
//! processo não basta.
//!
//! O transporte tem de entregar o PID. TCP em loopback não entrega
//! (`SO_PEERCRED` / `GetNamedPipeClientProcessId` não existem aí). A app
//! escuta um socket Unix (Linux: `SO_PEERCRED`; macOS: `LOCAL_PEERPID`,
//! porque `getpeereid` só devolve uid/gid) ou um named pipe no Windows
//! (`GetNamedPipeClientProcessId`). Sem esse PID a chamada fecha.
//!
//! Plataformas Unix sem API de PID do peer ficam no token, de propósito
//! e documentado (`ancestry_required` é falso). Linux, macOS e Windows
//! exigem os dois.
//!
//! Terminais restaurados reanexam o PTY vivo: o processo conserva o
//! ambiente e este registro conserva o token e o PID. Um PTY novo para a
//! mesma aba troca os dois. O valor do token não vai na linha de comando
//! do Codex: o sandbox herda pelo perfil em arquivo (ver `pty_manager`).
//!
//! Fleet, Dreaming e o MCP da missão não passam por `ags memory` /
//! `ags swarm`. Essas ferramentas rodam dentro do processo (`memory.list`,
//! `memory.searchApproved`, `task_tool`). Não há outro emissor de sessão:
//! quem chama a CLI fora de um terminal de aba é recusado.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

/// Nome da variável que o app grava no PTY e a CLI lê. O agente não escolhe o valor.
pub const SESSION_ENV: &str = "ADE_SESSION";

// Cada erro diz o que fazer: quem lê é o agente, e um "recusado" seco o fazia tentar de novo do mesmo jeito.
const ERR_MISSING: &str = "Este comando só funciona dentro de um terminal do ADE AGS (sessão do terminal ausente). \
Rode o `ags` no shell da própria aba ou conversa aberta no app. Se você está nela, algo limpou o ambiente \
(sandbox do agente, `env -i`, sudo, um servidor MCP lançado fora dela): confira com `echo $ADE_TAB_ID`; sem valor, peça à pessoa para abrir o agente por uma aba do ADE AGS.";
const ERR_UNKNOWN: &str = "A sessão deste terminal não é reconhecida (o app reiniciou ou o terminal foi trocado). \
Peça à pessoa para reabrir o terminal desta aba ou retomar a conversa; não reinicie o app por isso.";
const ERR_FORGED: &str = "ADE_TAB_ID não corresponde a este terminal. Não defina ADE_TAB_ID, ADE_SESSION nem --from à mão: \
use o ambiente que o app deu a este terminal.";
const ERR_NO_PID: &str = "Não foi possível confirmar o processo deste terminal (PID do cliente ausente). O comando foi recusado. \
Use o `ags` que vem com o app (`ags --version`) direto do shell do agente: ele fala pelo socket local, que informa o PID; TCP e proxies não informam.";
const ERR_CONVERSATION_UNKNOWN: &str = "Esta conversa não tem um processo registrado no ADE AGS (ela precisa estar aberta no app). \
Mande uma mensagem na conversa para o agente voltar e repita o comando de dentro dela.";
const ERR_ANCESTRY: &str = "O processo que chamou este comando não pertence ao terminal desta aba. O comando foi recusado. \
Rode o `ags` no próprio shell da aba ou da conversa: um daemon, `nohup`/`setsid`, outro terminal ou um servidor lançado fora dela não herdam a identidade.";

/// Profundidade máxima da caminhada de pais. Um ciclo ou uma árvore
/// absurda fecha em vez de andar para sempre.
const MAX_ANCESTORS: usize = 64;

#[derive(Clone)]
struct Bound {
    tab: String,
    root_pid: u32,
}

struct Sessions {
    by_token: HashMap<String, Bound>,
    by_tab: HashMap<String, String>,
    /// Conversas por protocolo: o PID do processo do motor, por `thread:<id>`. Sem token.
    conversations: HashMap<String, u32>,
    /// Token já entregue ao ambiente de uma conversa (`thread_env`) que espera o PID do motor para virar sessão.
    pending: HashMap<String, String>,
    /// Tarefas da Frota: o PID do processo do agente, registrado pelo supervisor ao lançá-lo (F-02).
    task_roots: HashMap<String, u32>,
}

fn registry() -> MutexGuard<'static, Sessions> {
    static REGISTRY: LazyLock<Mutex<Sessions>> = LazyLock::new(|| {
        Mutex::new(Sessions {
            by_token: HashMap::new(),
            by_tab: HashMap::new(),
            conversations: HashMap::new(),
            pending: HashMap::new(),
            task_roots: HashMap::new(),
        })
    });
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Linux, macOS e Windows sabem o PID do peer e a árvore de pais.
/// Nos outros Unix a API não existe: o token continua valendo sozinho,
/// e isso é o fallback explícito — não uma falha silenciosa.
pub(crate) fn ancestry_required() -> bool {
    cfg!(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "windows"
    ))
}

/// Publica o token já gerado para o PTY desta aba, amarrado ao PID do
/// processo que o PTY lançou. Substitui o token anterior da mesma aba.
pub(crate) fn publish_token(tab_id: &str, token: &str, root_pid: u32) {
    publish_in(&mut registry(), tab_id, token, root_pid);
}

fn publish_in(sessions: &mut Sessions, tab_id: &str, token: &str, root_pid: u32) {
    if let Some(previous) = sessions.by_tab.insert(tab_id.to_string(), token.to_string()) {
        if previous != token {
            sessions.by_token.remove(&previous);
        }
    }
    sessions.by_token.insert(
        token.to_string(),
        Bound { tab: tab_id.to_string(), root_pid },
    );
}

/// Emite o `ADE_SESSION` do próximo processo do motor de `thread:<id>`. Fica pendente até
/// [`register_conversation`] saber o PID; um respawn emite outro e o anterior deixa de valer, como num PTY novo.
/// É um token de memória do processo (nunca vai para disco, banco, log ou URL), igual ao dos terminais.
pub(crate) fn issue_conversation_token(tab_id: &str) -> Option<String> {
    if !tab_id.starts_with(crate::chat_team::model::THREAD_PREFIX) {
        return None;
    }
    let token = uuid::Uuid::new_v4().to_string();
    registry().pending.insert(tab_id.to_string(), token.clone());
    Some(token)
}

/// Registra o processo do motor de uma conversa por protocolo (`thread:<id>`). Cada conversa tem o seu
/// processo; um respawn da mesma conversa troca o PID. Com o token emitido por [`issue_conversation_token`] a
/// conversa também tem sessão (memória e quadro da missão); sem ele, vale só a ancestralidade do PID do
/// cliente (ver [`authorize_actor`]).
pub(crate) fn register_conversation(tab_id: &str, root_pid: u32) {
    if tab_id.starts_with(crate::chat_team::model::THREAD_PREFIX) && root_pid > 0 {
        let mut sessions = registry();
        sessions.conversations.insert(tab_id.to_string(), root_pid);
        if let Some(token) = sessions.pending.remove(tab_id) {
            publish_in(&mut sessions, tab_id, &token, root_pid);
        }
    }
}

/// O PTY saiu do registro (fechou, foi substituído ou a app encerrou a sessão).
pub(crate) fn release_token(token: &str) {
    let mut sessions = registry();
    if let Some(bound) = sessions.by_token.remove(token) {
        if sessions.by_tab.get(&bound.tab).map(String::as_str) == Some(token) {
            sessions.by_tab.remove(&bound.tab);
        }
    }
}

/// A aba que este token realmente é, sem olhar o processo.
///
/// `claimed_tab` é o `ADE_TAB_ID` que a CLI enviou. Se vier vazio, vale a aba
/// amarrada ao token. Se vier preenchido e for diferente, a chamada é recusada.
#[cfg_attr(not(test), allow(dead_code))]
pub fn verified_tab(session: Option<&str>, claimed_tab: Option<&str>) -> Result<String, String> {
    Ok(bound_tab(session, claimed_tab)?.tab)
}

fn bound_tab(session: Option<&str>, claimed_tab: Option<&str>) -> Result<Bound, String> {
    let Some(session) = session.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(ERR_MISSING.into());
    };
    let Some(bound) = registry().by_token.get(session).cloned() else {
        return Err(ERR_UNKNOWN.into());
    };
    if let Some(claimed) = claimed_tab.map(str::trim).filter(|value| !value.is_empty()) {
        if claimed != bound.tab {
            return Err(ERR_FORGED.into());
        }
    }
    Ok(bound)
}

/// Token e ancestralidade. `client_pid` é o processo que abriu o IPC.
/// Sem ele, ou se não descende do PTY, a chamada fecha.
pub fn authorize(session: Option<&str>, claimed_tab: Option<&str>, client_pid: Option<u32>) -> Result<String, String> {
    let bound = bound_tab(session, claimed_tab)?;
    if !ancestry_required() {
        return Ok(bound.tab);
    }
    let Some(client) = client_pid.filter(|pid| *pid > 0) else {
        return Err(ERR_NO_PID.into());
    };
    if !descends_from(client, bound.root_pid, parent_pid) {
        return Err(ERR_ANCESTRY.into());
    }
    Ok(bound.tab)
}

/// Quem chama as ações do Jev e do computer use: um terminal de aba (token + ancestralidade, como
/// [`authorize`]) ou uma conversa por protocolo, sem token, cujo PID de cliente precisa descender do
/// processo registrado para aquela `thread:<id>`. Sem PID do peer (plataforma sem a API) a conversa é
/// recusada: não há como provar a identidade, e o token não existe para ela.
///
/// Só quem chama isto aceita conversa. `memory.*` e `swarm.*` continuam em [`authorize`], só de terminal.
pub fn authorize_actor(session: Option<&str>, claimed_tab: Option<&str>, client_pid: Option<u32>) -> Result<String, String> {
    if session.map(str::trim).is_some_and(|value| !value.is_empty()) {
        return authorize(session, claimed_tab, client_pid);
    }
    let tab = claimed_tab.map(str::trim).filter(|value| value.starts_with(crate::chat_team::model::THREAD_PREFIX));
    let Some(tab) = tab else {
        return Err(ERR_MISSING.into());
    };
    let Some(root) = registry().conversations.get(tab).copied() else {
        return Err(ERR_CONVERSATION_UNKNOWN.into());
    };
    let client = client_pid.filter(|pid| *pid > 0);
    match (ancestry_required(), client) {
        (true, Some(pid)) if descends_from(pid, root, parent_pid) => Ok(tab.to_string()),
        (true, Some(_)) => Err(ERR_ANCESTRY.into()),
        _ => Err(ERR_NO_PID.into()),
    }
}

const ERR_TASK_UNKNOWN: &str = "Esta tarefa não tem um processo registrado no ADE AGS (ela já terminou, não é da Frota ou o id está errado). \
O `taskId` só vale para quem é o próprio agente da tarefa.";
const ERR_TASK_ANCESTRY: &str = "O processo que chamou não pertence a esta tarefa: o `taskId` só vale para o agente que o app lançou para ela \
e os processos que ele mesmo abriu (o `ags mcp` dele). O comando foi recusado.";
const ERR_STRIPPED: &str = "Este processo roda dentro de um terminal ou conversa do ADE AGS, mas chamou sem a identidade dele (sem ADE_SESSION e sem ADE_TAB_ID: \
`env -i`, sandbox ou ambiente limpo). O comando foi recusado: rode o `ags` com o ambiente que o app deu ao terminal do agente.";

/// O processo do agente de uma tarefa da Frota. O supervisor registra o PID ao lançá-lo; o `taskId` de um pedido só
/// vale se o cliente do IPC for ele ou um descendente (F-02). Substitui o registro anterior da mesma tarefa.
pub fn register_task_process(task_id: &str, root_pid: u32) {
    if root_pid > 0 {
        registry().task_roots.insert(task_id.to_string(), root_pid);
    }
}

pub fn release_task_process(task_id: &str) {
    registry().task_roots.remove(task_id);
}

/// O pedido que declara `task_id` vem mesmo do agente dessa tarefa? PID do cliente do canal de credencial (kernel) contra o
/// PID registrado. Sem PID (TCP) ou sem processo registrado, recusa. Nos Unix sem API de PID fica só o `taskId` declarado
/// (o mesmo fallback explícito de [`authorize`]).
pub fn authorize_task(task_id: &str, client_pid: Option<u32>) -> Result<(), String> {
    authorize_task_with(task_id, client_pid, parent_pid)
}

fn authorize_task_with(task_id: &str, client_pid: Option<u32>, parent: impl FnMut(u32) -> Option<u32>) -> Result<(), String> {
    if !ancestry_required() {
        return Ok(());
    }
    let Some(root) = registry().task_roots.get(task_id).copied() else {
        return Err(ERR_TASK_UNKNOWN.into());
    };
    let Some(client) = client_pid.filter(|pid| *pid > 0) else {
        return Err(ERR_NO_PID.into());
    };
    if descends_from(client, root, parent) { Ok(()) } else { Err(ERR_TASK_ANCESTRY.into()) }
}

/// Quem chama, depois de o servidor provar o que pôde (F-09, `peer.answer`, `fix.decide`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// Terminal de aba ou conversa por protocolo, provado por token e PID (ou, numa conversa, só pelo PID).
    Tab(String),
    /// Sem identidade do ADE e fora de todo processo do ADE: a pessoa num terminal próprio. Não prova que não
    /// seja um agente que se destacou da árvore (`setsid`, duplo fork): quem exige prova de papel recusa.
    Outside,
}

/// Classifica quem chama. Identidade declarada (`ADE_SESSION` ou `ADE_TAB_ID`) tem de ser provada ([`authorize_actor`]); sem
/// nenhuma, o cliente tem de estar fora de toda árvore de processos do ADE (PTYs, conversas, tarefas): quem está dentro e
/// chamou sem identidade apagou o ambiente de propósito (ou por sandbox) e é recusado. Sem PID do cliente não há como saber.
pub fn classify_caller(session: Option<&str>, from: Option<&str>, client_pid: Option<u32>) -> Result<Caller, String> {
    classify_caller_with(session, from, client_pid, parent_pid)
}

fn classify_caller_with(session: Option<&str>, from: Option<&str>, client_pid: Option<u32>, parent: impl FnMut(u32) -> Option<u32>) -> Result<Caller, String> {
    let declared = |value: Option<&str>| value.map(str::trim).is_some_and(|v| !v.is_empty());
    if declared(session) || declared(from) {
        return authorize_actor(session, from, client_pid).map(Caller::Tab);
    }
    if !ancestry_required() {
        return Ok(Caller::Outside);
    }
    let Some(client) = client_pid.filter(|pid| *pid > 0) else {
        return Err(ERR_NO_PID.into());
    };
    if inside_an_ade_process(client, parent) { Err(ERR_STRIPPED.into()) } else { Ok(Caller::Outside) }
}

/// `pid` é (ou descende de) o processo de algum PTY, conversa ou tarefa registrados.
fn inside_an_ade_process(pid: u32, mut parent: impl FnMut(u32) -> Option<u32>) -> bool {
    let roots: Vec<u32> = {
        let sessions = registry();
        sessions
            .by_token
            .values()
            .map(|bound| bound.root_pid)
            .chain(sessions.conversations.values().copied())
            .chain(sessions.task_roots.values().copied())
            .collect()
    };
    roots.into_iter().any(|root| descends_from(pid, root, &mut parent))
}

/// `client` é `root` ou um descendente, segundo `parent`. Para no init,
/// em ciclo ou depois de [`MAX_ANCESTORS`] passos.
pub(crate) fn descends_from(client: u32, root: u32, mut parent: impl FnMut(u32) -> Option<u32>) -> bool {
    if client == 0 || root == 0 {
        return false;
    }
    let mut current = client;
    let mut seen = Vec::with_capacity(8);
    for _ in 0..MAX_ANCESTORS {
        if current == root {
            return true;
        }
        if current <= 1 || seen.contains(&current) {
            return false;
        }
        seen.push(current);
        match parent(current) {
            Some(next) if next != current && next != 0 => current = next,
            _ => return false,
        }
    }
    false
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn parent_pid(pid: u32) -> Option<u32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("PPid:") {
            return rest.trim().parse().ok().filter(|ppid| *ppid > 0);
        }
    }
    None
}

/// `getpeereid` não traz PID. O pai vem de `proc_pidinfo(PROC_PIDTBSDINFO)`, em `pbi_ppid`.
/// (Não `sysctl(KERN_PROC_PID)`: a `libc` não expõe `kinfo_proc` no macOS e o build quebrava.)
#[cfg(target_os = "macos")]
fn parent_pid(pid: u32) -> Option<u32> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void, size)
    };
    if read != size {
        return None;
    }
    Some(info.pbi_ppid).filter(|ppid| *ppid > 0)
}

/// `CreateToolhelp32Snapshot` enxerga o pai. Se o PID não está no
/// snapshot, a checagem fecha: não há como provar a descendência.
#[cfg(windows)]
fn parent_pid(pid: u32) -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) == 0 {
            CloseHandle(snap);
            return None;
        }
        loop {
            if entry.th32ProcessID == pid {
                let ppid = entry.th32ParentProcessID;
                CloseHandle(snap);
                return if ppid == 0 { None } else { Some(ppid) };
            }
            if Process32NextW(snap, &mut entry) == 0 {
                break;
            }
        }
        CloseHandle(snap);
        None
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "windows"
)))]
fn parent_pid(_pid: u32) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Issued {
        tab: String,
        token: String,
    }

    impl Issued {
        fn new(label: &str) -> Self {
            let tab = format!("{label}-{}", uuid::Uuid::new_v4());
            let token = uuid::Uuid::new_v4().to_string();
            publish_token(&tab, &token, std::process::id());
            Self { tab, token }
        }
    }

    impl Drop for Issued {
        fn drop(&mut self) {
            release_token(&self.token);
        }
    }

    #[test]
    fn forged_ade_tab_id_is_rejected() {
        let issued = Issued::new("forged");
        let err = verified_tab(Some(&issued.token), Some("other-tab")).unwrap_err();
        assert!(err.contains("ADE_TAB_ID"), "{err}");
        assert_eq!(verified_tab(Some(&issued.token), Some(&issued.tab)).unwrap(), issued.tab);
        assert_eq!(verified_tab(Some(&issued.token), None).unwrap(), issued.tab);
        assert_eq!(verified_tab(Some(&issued.token), Some("  ")).unwrap(), issued.tab);
    }

    #[test]
    fn missing_or_unknown_session_is_rejected() {
        let issued = Issued::new("unknown");
        assert!(verified_tab(None, Some(&issued.tab)).unwrap_err().contains("ausente"));
        assert!(verified_tab(Some(""), Some(&issued.tab)).unwrap_err().contains("ausente"));
        assert!(verified_tab(Some("not-a-session"), Some(&issued.tab)).unwrap_err().contains("não é reconhecida"));
    }

    #[test]
    fn reattached_terminal_keeps_its_token() {
        let issued = Issued::new("reattach");
        assert_eq!(verified_tab(Some(&issued.token), Some(&issued.tab)).unwrap(), issued.tab);
        assert_eq!(verified_tab(Some(&issued.token), Some(&issued.tab)).unwrap(), issued.tab);
    }

    #[test]
    fn replaced_terminal_invalidates_the_previous_token() {
        let tab = format!("replaced-{}", uuid::Uuid::new_v4());
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        publish_token(&tab, &first, 10);
        publish_token(&tab, &second, 11);
        assert!(verified_tab(Some(&first), Some(&tab)).is_err());
        assert_eq!(verified_tab(Some(&second), Some(&tab)).unwrap(), tab);
        release_token(&second);
        assert!(verified_tab(Some(&second), Some(&tab)).unwrap_err().contains("não é reconhecida"));
    }

    #[test]
    fn conversa_sem_token_so_passa_pelo_pid_do_proprio_processo() {
        let thread = format!("{}teste-actor", crate::chat_team::model::THREAD_PREFIX);
        let outra = format!("{}teste-outra", crate::chat_team::model::THREAD_PREFIX);
        // Sem registro: recusada, mesmo com PID.
        assert!(authorize_actor(None, Some(&thread), Some(std::process::id())).unwrap_err().contains("não tem um processo"));
        register_conversation(&thread, std::process::id());
        if ancestry_required() {
            assert_eq!(authorize_actor(None, Some(&thread), Some(std::process::id())).unwrap(), thread);
            assert!(authorize_actor(None, Some(&thread), None).unwrap_err().contains("PID"));
            assert!(authorize_actor(None, Some(&thread), Some(1)).unwrap_err().contains("não pertence"));
            // Outra conversa não herda o processo desta.
            register_conversation(&outra, std::process::id().wrapping_add(7_000_000));
            assert!(authorize_actor(None, Some(&outra), Some(std::process::id())).is_err());
        }
        // Terminal sem token continua recusado, e o `authorize` de memória/swarm não aceita conversa.
        assert!(authorize_actor(None, Some("tab-de-terminal"), Some(std::process::id())).unwrap_err().contains("ausente"));
        assert!(authorize(None, Some(&thread), Some(std::process::id())).is_err());
        // Token de terminal não vale para outra aba mesmo com o PID certo.
        let issued = Issued::new("actor");
        assert!(authorize_actor(Some(&issued.token), Some(&thread), Some(std::process::id())).unwrap_err().contains("ADE_TAB_ID"));
    }

    #[test]
    fn ancestry_accepts_self_and_a_child_and_rejects_the_rest() {
        let mut parents = HashMap::from([(3, 2), (2, 1)]);
        assert!(descends_from(1, 1, |pid| parents.get(&pid).copied()));
        assert!(descends_from(3, 1, |pid| parents.get(&pid).copied()));
        assert!(!descends_from(3, 9, |pid| parents.get(&pid).copied()));
        assert!(!descends_from(0, 1, |pid| parents.get(&pid).copied()));
        assert!(!descends_from(3, 0, |pid| parents.get(&pid).copied()));
        parents.insert(5, 6);
        parents.insert(6, 5);
        assert!(!descends_from(5, 1, |pid| parents.get(&pid).copied()));
    }

    #[test]
    fn token_without_client_pid_is_refused_when_ancestry_is_required() {
        let issued = Issued::new("pid");
        if !ancestry_required() {
            assert_eq!(authorize(Some(&issued.token), Some(&issued.tab), None).unwrap(), issued.tab);
            return;
        }
        let missing = authorize(Some(&issued.token), Some(&issued.tab), None).unwrap_err();
        assert!(missing.contains("PID"), "{missing}");
        let forged = authorize(Some(&issued.token), Some("other-tab"), Some(std::process::id())).unwrap_err();
        assert!(forged.contains("ADE_TAB_ID"), "{forged}");
        assert_eq!(
            authorize(Some(&issued.token), Some(&issued.tab), Some(std::process::id())).unwrap(),
            issued.tab
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_spawned_child_belongs_to_this_process_and_init_does_not() {
        let issued = Issued::new("child");
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        assert_eq!(
            authorize(Some(&issued.token), Some(&issued.tab), Some(pid)).unwrap(),
            issued.tab,
            "o filho do teste tem de passar como descendente do processo que publicou o token"
        );
        let stranger = authorize(Some(&issued.token), Some(&issued.tab), Some(1)).unwrap_err();
        assert!(stranger.contains("não pertence"), "{stranger}");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn cada_recusa_diz_o_que_fazer_e_nenhuma_manda_reiniciar_o_app() {
        for err in [ERR_MISSING, ERR_UNKNOWN, ERR_FORGED, ERR_NO_PID, ERR_CONVERSATION_UNKNOWN, ERR_ANCESTRY] {
            assert!(
                ["Rode ", "Peça ", "Use ", "Mande ", "Não defina "].iter().any(|verb| err.contains(verb)),
                "a recusa precisa dizer o próximo passo: {err}"
            );
            // Reiniciar o app fecha os terminais e agentes da pessoa (AGENTS.md, regra 2.1).
            assert!(!err.contains("Reinicie o app"), "{err}");
        }
        // Mensagens antigas continuam reconhecíveis por quem as procura (cli_smoke, chat_team::env).
        assert!(ERR_MISSING.contains("sessão do terminal ausente"));
        assert!(ERR_UNKNOWN.contains("não é reconhecida"));
        assert!(ERR_ANCESTRY.contains("não pertence"));
    }

    // ── F-02: `taskId` provado pelo PID, não declarado ──────────────────────────────────────

    fn task_id(label: &str) -> String {
        format!("{label}-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn taskid_so_vale_para_o_processo_que_o_supervisor_lancou_e_seus_descendentes() {
        if !ancestry_required() {
            return;
        }
        let task = task_id("tarefa");
        register_task_process(&task, 100);
        let parents = HashMap::from([(300, 200), (200, 100), (900, 800)]);
        let parent = |pid: u32| parents.get(&pid).copied();
        // O próprio agente e o MCP que ele lançou (neto) provam a tarefa.
        assert!(authorize_task_with(&task, Some(100), parent).is_ok());
        assert!(authorize_task_with(&task, Some(300), parent).is_ok());
        // Um processo de outra árvore (outra tarefa, uma aba, a pessoa) não prova nada, mesmo com o token certo.
        let intruso = authorize_task_with(&task, Some(900), parent).unwrap_err();
        assert!(intruso.contains("não pertence"), "{intruso}");
        release_task_process(&task);
    }

    #[test]
    fn taskid_sem_pid_do_cliente_ou_sem_processo_registrado_e_recusado() {
        if !ancestry_required() {
            return;
        }
        let task = task_id("tarefa");
        register_task_process(&task, 100);
        assert!(authorize_task_with(&task, None, |_| None).unwrap_err().contains("PID"), "o TCP não traz PID");
        // Um id inventado (ou de uma tarefa que já saiu) não tem processo: não há como provar.
        let inventado = task_id("inventada");
        assert!(authorize_task_with(&inventado, Some(100), |_| None).unwrap_err().contains("não tem um processo"));
        release_task_process(&task);
        assert!(authorize_task_with(&task, Some(100), |_| None).is_err(), "depois de liberada a tarefa não se prova mais");
    }

    #[test]
    fn o_processo_de_uma_tarefa_nao_prova_outra_tarefa() {
        if !ancestry_required() {
            return;
        }
        let (a, b) = (task_id("a"), task_id("b"));
        register_task_process(&a, 100);
        register_task_process(&b, 500);
        assert!(authorize_task_with(&a, Some(100), |_| None).is_ok());
        assert!(authorize_task_with(&b, Some(100), |_| None).is_err(), "a tarefa A agiu como a tarefa B");
        release_task_process(&a);
        release_task_process(&b);
    }

    // ── Quem chama (F-09, peer.answer, fix.decide) ──────────────────────────────────────────

    #[test]
    fn quem_chama_de_um_terminal_provado_e_a_aba() {
        let issued = Issued::new("quem");
        let caller = classify_caller(Some(&issued.token), Some(&issued.tab), Some(std::process::id()));
        assert_eq!(caller.unwrap(), Caller::Tab(issued.tab.clone()));
    }

    #[test]
    fn identidade_declarada_sem_prova_e_recusada() {
        let issued = Issued::new("falsa");
        // ADE_TAB_ID sem sessão: declarado, não provado.
        assert!(classify_caller(None, Some(&issued.tab), Some(std::process::id())).is_err());
        // Sessão de outra aba com a identidade de uma terceira.
        assert!(classify_caller(Some(&issued.token), Some("outra-aba"), Some(std::process::id())).is_err());
    }

    #[test]
    fn sem_identidade_dentro_de_um_processo_do_ade_e_agente_que_apagou_o_ambiente_e_e_recusado() {
        if !ancestry_required() {
            return;
        }
        let issued = Issued::new("env-i");
        // `env -i ags …` dentro do terminal: sem ADE_TAB_ID nem ADE_SESSION, mas o PID descende do PTY.
        let refused = classify_caller(None, None, Some(std::process::id())).unwrap_err();
        assert!(refused.contains("sem a identidade dele"), "{refused}");
        drop(issued);
    }

    #[test]
    fn sem_identidade_e_fora_de_todo_processo_do_ade_e_a_pessoa_no_proprio_terminal() {
        if !ancestry_required() {
            return;
        }
        // PID 1 nunca descende de PTY nenhum.
        assert_eq!(classify_caller(None, None, Some(1)).unwrap(), Caller::Outside);
        assert_eq!(classify_caller(Some(" "), Some(""), Some(1)).unwrap(), Caller::Outside, "campos vazios não são identidade");
        // Sem PID (TCP) não dá para saber de que lado está: recusa.
        assert!(classify_caller(None, None, None).is_err());
    }
}
