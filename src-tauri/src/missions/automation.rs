//! "Armado" não sobrevive ao reinício: o que ficou ligado antes de o app fechar espera um gesto.
//!
//! Missão, time e rotina podem continuar `running` no banco depois que o app fecha. Ao reabrir, nada
//! automático que age sobre um agente volta sozinho por causa disso: a cutucada do Vigia (front), a
//! recuperação de uma rotina com catch-up (`ipc::commands::routine`) e a rodada de correção automática de
//! um run da frota (`runs::fixrounds`). Cada um pergunta [`paused_for`] com o instante em que foi armado;
//! o que nasceu depois do boot (uma missão iniciada agora, um run novo) é um gesto novo e roda normal.
//!
//! Só a pessoa retoma, pelo botão "Retomar automação" da tela ([`automation_resume`]). Não há comando de
//! CLI nem de MCP para isso: um agente não religa a própria supervisão. O estado é só do processo; o
//! próximo boot pausa de novo o que estiver armado.

use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Evento para a tela recarregar o estado (o botão some depois de retomar).
pub const CHANGED_EVENT: &str = "cc-automation-changed";

/// Quando o processo subiu e quando a pessoa retomou (ms).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gate {
    pub boot_ms: i64,
    pub resumed_at: Option<i64>,
}

impl Gate {
    /// Algo armado em `armed_at_ms` está pausado? Só o que é de antes do boot, e só até retomar. Pura.
    pub fn pauses(&self, armed_at_ms: i64) -> bool {
        self.resumed_at.is_none() && armed_at_ms < self.boot_ms
    }
}

static BOOT_MS: OnceLock<i64> = OnceLock::new();
static RESUMED_AT: Mutex<Option<i64>> = Mutex::new(None);

/// Marca o boot. Chamado no arranque (`app::run`); o primeiro acesso também marca.
pub fn mark_boot() -> i64 {
    *BOOT_MS.get_or_init(crate::util::now_ts_ms)
}

pub fn gate() -> Gate {
    Gate { boot_ms: mark_boot(), resumed_at: *RESUMED_AT.lock().unwrap_or_else(|e| e.into_inner()) }
}

/// Armado em `armed_at_ms` (ms) e ainda pausado pelo reinício.
pub fn paused_for(armed_at_ms: i64) -> bool {
    gate().pauses(armed_at_ms)
}

/// O mesmo, com o instante em segundos (como `missions.started_at` e `runs.created_at`). Conta o
/// fim do segundo: o que nasceu no mesmo segundo do boot não passa por armado antes dele.
pub fn paused_for_secs(armed_at_secs: i64) -> bool {
    paused_for(armed_at_secs.saturating_mul(1000).saturating_add(999))
}

/// Uma missão em andamento que foi iniciada antes do boot.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedMission {
    pub id: String,
    pub title: String,
}

/// Uma rotina que perdeu a hora com o app fechado e pediu para recuperar.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedRoutine {
    pub id: String,
    pub name: String,
}

/// Uma tarefa estruturada armada antes do boot, aguardando a pessoa retomar a automação.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedScheduledTask {
    pub id: String,
    pub name: String,
}

/// O que a tela mostra: o que ficou pausado pelo reinício.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Há algo armado de antes do boot esperando a pessoa.
    pub paused: bool,
    pub boot_ms: i64,
    pub resumed_at: Option<i64>,
    pub missions: Vec<ArmedMission>,
    pub routines: Vec<ArmedRoutine>,
    pub scheduled_tasks: Vec<ArmedScheduledTask>,
    /// Rodadas de correção da frota que o fechamento interrompeu (o sweep do boot as marcou como
    /// falhas). Não voltam sozinhas nem com o botão: o lead delas morreu com o app.
    pub interrupted_fix_rounds: i64,
}

/// O estado, lido do banco e das rotinas. `gate` e `routines` entram por parâmetro para testar.
pub fn status(conn: &Connection, gate: Gate, routines: &[crate::routines::Routine]) -> Result<Status, String> {
    status_with_scheduled_tasks(conn, gate, routines, &[])
}

fn status_with_scheduled_tasks(
    conn: &Connection,
    gate: Gate,
    routines: &[crate::routines::Routine],
    tasks: &[crate::scheduled_tasks::ScheduledTask],
) -> Result<Status, String> {
    let boot_secs = gate.boot_ms / 1000;
    let mut stmt = conn
        .prepare("SELECT id, title FROM missions WHERE status = 'running' AND started_at IS NOT NULL AND started_at > 0 AND started_at < ?1 ORDER BY started_at, id")
        .map_err(|e| e.to_string())?;
    let missions = stmt
        .query_map([boot_secs], |r| Ok(ArmedMission { id: r.get(0)?, title: r.get(1)? }))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let routines: Vec<ArmedRoutine> = crate::routines::pending_catch_up(routines)
        .into_iter()
        .filter_map(|id| routines.iter().find(|r| r.id == id).map(|r| ArmedRoutine { id: r.id.clone(), name: r.name.clone() }))
        .collect();
    let scheduled_tasks: Vec<ArmedScheduledTask> = tasks.iter()
        .filter(|task| task.enabled && gate.pauses(task.armed_at_ms))
        .map(|task| ArmedScheduledTask { id: task.id.clone(), name: task.name.clone() })
        .collect();
    let interrupted_fix_rounds: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE fix_round > 0 AND error = ?1 AND COALESCE(ended_at, 0) >= ?2",
            rusqlite::params![crate::runs::store::SWEPT_RUNNING_ERROR, boot_secs],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let armed = !missions.is_empty() || !routines.is_empty() || !scheduled_tasks.is_empty();
    Ok(Status {
        paused: gate.resumed_at.is_none() && armed,
        boot_ms: gate.boot_ms,
        resumed_at: gate.resumed_at,
        missions,
        routines,
        scheduled_tasks,
        interrupted_fix_rounds,
    })
}

/// Retoma tudo. Idempotente: a segunda chamada mantém o primeiro instante.
pub fn resume(now_ms: i64) -> Gate {
    let mut resumed = RESUMED_AT.lock().unwrap_or_else(|e| e.into_inner());
    if resumed.is_none() {
        *resumed = Some(now_ms);
    }
    drop(resumed);
    gate()
}

/// O catch-up de uma rotina desiste 15 min depois de o app abrir. Com a automação pausada, o prazo
/// conta de quando a pessoa retomou. Pura.
pub fn catch_up_started(gate: Gate, started_secs: i64) -> i64 {
    gate.resumed_at.map(|ms| (ms / 1000).max(started_secs)).unwrap_or(started_secs)
}

fn current(db: &crate::database::DbConnection) -> Result<Status, String> {
    let routines = crate::routines::all();
    let tasks = crate::scheduled_tasks::all().unwrap_or_else(|error| {
        eprintln!("[tarefas agendadas] não foi possível ler o estado de pausa: {error}");
        Vec::new()
    });
    let conn = db.lock().map_err(|e| e.to_string())?;
    status_with_scheduled_tasks(&conn, gate(), &routines, &tasks)
}

#[tauri::command]
pub fn automation_status(db: tauri::State<'_, crate::database::DbConnection>) -> Result<Status, String> {
    current(&db)
}

/// O botão "Retomar automação". Só a tela chama (não há CLI nem MCP).
#[tauri::command]
pub fn automation_resume(app: AppHandle, db: tauri::State<'_, crate::database::DbConnection>) -> Result<Status, String> {
    resume(crate::util::now_ts_ms());
    let status = current(&db)?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(status)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn so_pausa_o_que_foi_armado_antes_do_boot_e_ate_retomar() {
        let gate = Gate { boot_ms: 10_000, resumed_at: None };
        assert!(gate.pauses(9_999), "armado antes do boot");
        assert!(!gate.pauses(10_000), "nascido no boot é gesto novo");
        assert!(!gate.pauses(20_000));
        let resumed = Gate { resumed_at: Some(15_000), ..gate };
        assert!(!resumed.pauses(1), "depois de retomar nada fica pausado");
    }

    #[test]
    fn o_prazo_do_catch_up_conta_de_quando_a_pessoa_retomou() {
        let gate = Gate { boot_ms: 100_000, resumed_at: None };
        assert_eq!(catch_up_started(gate, 100), 100);
        assert_eq!(catch_up_started(Gate { resumed_at: Some(900_000), ..gate }, 100), 900);
    }

    fn routine(id: &str, missed: Option<i64>) -> crate::routines::Routine {
        crate::routines::Routine {
            id: id.into(),
            name: format!("r-{id}"),
            text: "oi".into(),
            target_tab: None,
            target_name: String::new(),
            creator: "t".into(),
            schedule: crate::routines::Schedule::Daily { hour: 9, minute: 0, days: Vec::new() },
            enabled: true,
            next_run: None,
            last_run: None,
            last_result: String::new(),
            runs: 0,
            catch_up: true,
            missed_at: missed,
        }
    }

    #[test]
    fn o_status_lista_missoes_de_antes_do_boot_e_rotinas_a_recuperar() {
        let conn = crate::database::test_db();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'w', 0, 0);
             INSERT INTO missions (id, workspace_id, title, objective, cwd, status, started_at, created_at, updated_at)
               VALUES ('velha', 'w', 'Velha', 'o', '/p', 'running', 50, 1, 1),
                      ('nova', 'w', 'Nova', 'o', '/p', 'running', 150, 1, 1),
                      ('fechada', 'w', 'Fechada', 'o', '/p', 'done', 50, 1, 1);",
        )
        .unwrap();
        let gate = Gate { boot_ms: 100_000, resumed_at: None };
        let routines = [routine("a", Some(40)), routine("b", None)];
        let s = status(&conn, gate, &routines).unwrap();
        assert!(s.paused);
        assert_eq!(s.missions, vec![ArmedMission { id: "velha".into(), title: "Velha".into() }]);
        assert_eq!(s.routines.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(s.interrupted_fix_rounds, 0);
        let after = status(&conn, Gate { resumed_at: Some(200_000), ..gate }, &routines).unwrap();
        assert!(!after.paused, "retomado, o botão some");
        let empty = status(&conn, Gate { boot_ms: 10_000, resumed_at: None }, &[]).unwrap();
        assert!(!empty.paused, "sem nada armado de antes, nada a retomar");
    }
}
