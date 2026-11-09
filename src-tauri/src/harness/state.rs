//! Estado do nó derivado do estado nativo (contrato §3.2). Funções puras: na Fase 1 não existe coluna
//! de estado em `harness_node`, então o nativo é a única fonte e não há escrita dupla para divergir.
//!
//! Só o vocabulário do nó vive aqui; a projeção de leitura (`runs::harness`) continua devolvendo o
//! texto nativo ao front até a UI migrar.

use crate::runs::store::SWEPT_RUNNING_ERROR;
use crate::runs::types::status;

/// Estados do nó. Não terminais: `Pending`, `Running`, `Waiting`. `RolledBack` fica reservado.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeState {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Skipped,
    HandedOff,
}

impl NodeState {
    pub const fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending | Self::Running | Self::Waiting)
    }
}

/// Por que o estado é terminal quando o nativo não diz.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    AppClosed,
    DependencyFailed,
    UnmappedNativeStatus,
}

/// Estado derivado, com o atributo que acompanha um terminal (não é um estado).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Derived {
    pub state: NodeState,
    pub end_reason: Option<EndReason>,
    pub outcome_unknown: bool,
}

const fn plain(state: NodeState) -> Derived {
    Derived { state, end_reason: None, outcome_unknown: false }
}

/// `chat_run.status`. `waiting` é quando há `chat_request.pending` do turno.
pub fn from_chat_run(status: &str, has_pending_request: bool) -> Derived {
    match status {
        "inProgress" if has_pending_request => plain(NodeState::Waiting),
        "inProgress" => plain(NodeState::Running),
        "completed" => plain(NodeState::Completed),
        "failed" => plain(NodeState::Failed),
        "interrupted" => plain(NodeState::Interrupted),
        // O Codex grava o `turn.status` como veio: um valor desconhecido nunca vira terminal conhecido.
        _ => Derived {
            state: NodeState::Interrupted,
            end_reason: Some(EndReason::UnmappedNativeStatus),
            outcome_unknown: true,
        },
    }
}

/// `tasks.status` (e `run_attempts.status`, mesmo vocabulário) com o erro gravado.
pub fn from_task(task_status: &str, error: Option<&str>) -> Derived {
    match task_status {
        status::PENDING | status::READY => plain(NodeState::Pending),
        status::RUNNING => plain(NodeState::Running),
        status::DONE => plain(NodeState::Completed),
        status::FAILED if error == Some(SWEPT_RUNNING_ERROR) => Derived {
            state: NodeState::Interrupted,
            end_reason: Some(EndReason::AppClosed),
            outcome_unknown: false,
        },
        status::FAILED => plain(NodeState::Failed),
        status::CANCELLED => plain(NodeState::Cancelled),
        status::HANDED_OFF => plain(NodeState::HandedOff),
        status::SKIPPED => Derived {
            state: NodeState::Skipped,
            end_reason: Some(EndReason::DependencyFailed),
            outcome_unknown: false,
        },
        _ => Derived {
            state: NodeState::Interrupted,
            end_reason: Some(EndReason::UnmappedNativeStatus),
            outcome_unknown: true,
        },
    }
}

/// `runs.status`: derivado das tarefas por `refresh_run`. Um run só com `handed_off` cai em
/// `cancelled` (o contrato registra, não corrige).
pub fn from_fleet_run(run_status: &str) -> Derived {
    match run_status {
        status::RUNNING => plain(NodeState::Running),
        status::DONE => plain(NodeState::Completed),
        status::FAILED => plain(NodeState::Failed),
        status::CANCELLED => plain(NodeState::Cancelled),
        _ => Derived {
            state: NodeState::Interrupted,
            end_reason: Some(EndReason::UnmappedNativeStatus),
            outcome_unknown: true,
        },
    }
}
