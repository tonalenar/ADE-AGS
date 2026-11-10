//! Identidade durável do harness (Fase 1): tipos do `HarnessRun` e do nó de execução.
//!
//! O nó não copia estado: `source_kind` + `source_ref` apontam para o registro nativo (turno, conversa,
//! run ou tarefa da Frota), e o estado continua sendo lido de lá. O `legacy_ref` é o id textual que a
//! projeção antiga (`runs::harness`) e os eventos já usam, e fica para sempre.

/// O que o nó é. Valores validados em Rust (sem `CHECK` no SQLite, ver contrato §4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeKind {
    /// O turno raiz de uma conversa (`chat_run`).
    RootAgent,
    /// Uma conversa filha criada pelo ADE durante o turno.
    ChildChat,
    /// Um run da Frota delegado durante o turno.
    FleetRun,
    /// Uma tarefa do run da Frota.
    FleetTask,
}

impl NodeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RootAgent => "root_agent",
            Self::ChildChat => "child_chat",
            Self::FleetRun => "fleet_run",
            Self::FleetTask => "fleet_task",
        }
    }

    pub const fn source_kind(self) -> SourceKind {
        match self {
            Self::RootAgent => SourceKind::ChatRun,
            Self::ChildChat => SourceKind::ChatThread,
            Self::FleetRun => SourceKind::FleetRun,
            Self::FleetTask => SourceKind::FleetTask,
        }
    }
}

/// O registro nativo que o nó representa.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    ChatRun,
    ChatThread,
    FleetRun,
    FleetTask,
}

impl SourceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChatRun => "chat_run",
            Self::ChatThread => "chat_thread",
            Self::FleetRun => "fleet_run",
            Self::FleetTask => "fleet_task",
        }
    }
}

/// `source_ref` do turno raiz. O id do turno **não** é único entre conversas (a chave de `chat_run`
/// é composta), então a conversa vai junto, nunca sozinho.
pub fn chat_run_source_ref(thread_id: &str, turn_id: &str) -> String {
    format!("{thread_id}/{turn_id}")
}

/// `legacy_ref` do turno raiz: o mesmo id textual que `runs::harness` dá ao nó de turno.
pub fn turn_legacy_ref(thread_id: &str, turn_id: &str) -> String {
    format!("turn:{thread_id}:{turn_id}")
}

pub fn thread_legacy_ref(thread_id: &str) -> String {
    format!("thread:{thread_id}")
}

pub fn fleet_run_legacy_ref(run_id: &str) -> String {
    format!("run:{run_id}")
}

pub fn fleet_task_legacy_ref(task_id: &str) -> String {
    format!("task:{task_id}")
}
