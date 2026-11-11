//! Padrões de conversa por projeto: o agente e o modelo, o modelo reserva, o workspace e a permissão.
//!
//! Ficam no key-value `settings` do banco desta instância (aditivo: nenhuma tabela nova, nenhuma migração, e a
//! instância isolada tem os dela). Um registro por pasta de projeto, com o hash do caminho na chave, como a
//! política de agentes (`project_chat_policy`). Um worktree temporário usa o registro do projeto de origem.
//!
//! Dois consumidores:
//! - a tela (Configurações → Projetos e o composer), que lê e grava pelos comandos Tauri;
//! - quem abre conversa sem tela (a CLI `ags chat new`), que só herda o agente e o modelo: a permissão e o
//!   workspace NÃO valem para conversa aberta por agente, que sempre começa supervisionada.
//!
//! O modelo reserva vale quando o principal está sem limite de uso (o sinal é o mesmo que a frota e o pool de contas
//! já gravam, ver `conversa::limite::limited_until`). Nada aqui chama rede nem agente.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::database::DbConnection;
use crate::project_chat_policy::{normalize_cwd, project_root, validate_agent_id};

const SETTINGS_PREFIX: &str = "chat.project.defaults.v1.";
const MAX_MODEL: usize = 200;
const MAX_PROJECTS: usize = 2_000;

/// Um agente e, opcionalmente, o modelo dele (`None` = o padrão do agente).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub agent_id: String,
    #[serde(default)]
    pub model: Option<String>,
}

/// O que um projeto fixa para as conversas novas dele. Campo ausente = herda do aparelho.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectChatDefaults {
    pub cwd: String,
    pub primary: Option<ModelChoice>,
    /// O modelo reserva: entra no lugar do principal quando o principal está sem limite de uso.
    pub fallback: Option<ModelChoice>,
    /// `local` (o checkout atual) ou `worktree` (um worktree novo por conversa).
    pub workspace: Option<String>,
    /// `ask`, `safe`, `edits` ou `full`.
    pub access: Option<String>,
}

impl ProjectChatDefaults {
    fn is_empty(&self) -> bool {
        self.primary.is_none() && self.fallback.is_none() && self.workspace.is_none() && self.access.is_none()
    }
}

fn setting_key(normalized_cwd: &str) -> String {
    let digest = Sha256::digest(normalized_cwd.as_bytes());
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{SETTINGS_PREFIX}{hash}")
}

fn clean_choice(choice: ModelChoice) -> Result<ModelChoice, String> {
    validate_agent_id(&choice.agent_id)?;
    let model = match choice.model.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(model) if model.chars().count() > MAX_MODEL || model.chars().any(char::is_control) => {
            return Err("O nome do modelo é inválido".into());
        }
        Some(model) => Some(model.to_owned()),
    };
    Ok(ModelChoice { agent_id: choice.agent_id, model })
}

/// Confere e normaliza o que a tela mandou. Pura. O modelo reserva não pode ser igual ao principal: seria
/// um «reserva» que falha pelo mesmo motivo.
pub(crate) fn validate(raw: ProjectChatDefaults) -> Result<ProjectChatDefaults, String> {
    let cwd = normalize_cwd(&raw.cwd)?;
    let primary = raw.primary.map(clean_choice).transpose()?;
    let fallback = raw.fallback.map(clean_choice).transpose()?;
    if let (Some(primary), Some(fallback)) = (&primary, &fallback)
        && primary == fallback
    {
        return Err("O modelo reserva precisa ser diferente do principal".into());
    }
    let workspace = match raw.workspace.as_deref() {
        None => None,
        Some(mode @ ("local" | "worktree")) => Some(mode.to_owned()),
        Some(_) => return Err("O workspace padrão precisa ser local ou worktree".into()),
    };
    let access = match raw.access.as_deref() {
        None => None,
        Some(mode @ ("ask" | "safe" | "edits" | "full")) => Some(mode.to_owned()),
        Some(_) => return Err("A permissão padrão é inválida".into()),
    };
    Ok(ProjectChatDefaults { cwd, primary, fallback, workspace, access })
}

fn read_exact(conn: &Connection, normalized_cwd: &str) -> Result<Option<ProjectChatDefaults>, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [setting_key(normalized_cwd)], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else { return Ok(None) };
    let parsed: ProjectChatDefaults =
        serde_json::from_str(&raw).map_err(|_| "Os padrões deste projeto estão inválidos".to_string())?;
    let defaults = validate(parsed).map_err(|_| "Os padrões deste projeto estão inválidos".to_string())?;
    // O registro de outro caminho (hash colidido ou arquivo editado à mão) não vale para este.
    if defaults.cwd != normalized_cwd {
        return Err("Os padrões deste projeto estão inválidos".into());
    }
    Ok(Some(defaults))
}

/// Os padrões do projeto de `cwd` (a raiz do projeto, se `cwd` é um worktree temporário).
pub(crate) fn read(conn: &Connection, cwd: &str) -> Result<Option<ProjectChatDefaults>, String> {
    let root = project_root(conn, cwd)?;
    read_exact(conn, &root)
}

/// Quando o agente está sem limite: `Some(até quando, em segundos)`, ou `None` se está livre.
pub(crate) type LimitProbe<'a> = &'a dyn Fn(&str) -> Option<i64>;

/// O que valeria para uma conversa nova agora.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSelection {
    pub agent_id: String,
    pub model: Option<String>,
    /// O principal está sem limite e o reserva entrou no lugar.
    pub used_fallback: bool,
    /// Até quando o principal fica sem limite (segundos), quando o reserva entrou ou quando não havia reserva livre.
    pub limited_until: Option<i64>,
}

/// Escolhe o agente e o modelo: o principal, ou o reserva se o principal está sem limite e o reserva está livre.
/// Sem reserva livre, fica o principal (o limite aparece no turno, como sempre) e `limited_until` avisa. Pura.
pub(crate) fn effective(defaults: &ProjectChatDefaults, limited: LimitProbe) -> Option<EffectiveSelection> {
    let primary = defaults.primary.as_ref()?;
    let primary_limit = limited(&primary.agent_id);
    if let (Some(until), Some(fallback)) = (primary_limit, defaults.fallback.as_ref())
        && limited(&fallback.agent_id).is_none()
    {
        return Some(EffectiveSelection {
            agent_id: fallback.agent_id.clone(),
            model: fallback.model.clone(),
            used_fallback: true,
            limited_until: Some(until),
        });
    }
    Some(EffectiveSelection {
        agent_id: primary.agent_id.clone(),
        model: primary.model.clone(),
        used_fallback: false,
        limited_until: primary_limit,
    })
}

/// O que uma conversa aberta por agente (sem tela) herda do projeto: o agente e o modelo. `agent`/`model` são o que
/// quem abriu pediu; o pedido explícito sempre vale. Pura.
///
/// - Sem agente pedido: vale o principal do projeto (ou o reserva, se o principal está sem limite).
/// - Agente pedido igual ao principal e sem modelo: herda o modelo do principal (ou, no reserva, o do reserva).
/// - Qualquer outro caso: o pedido, sem mexer.
pub(crate) fn inherit_for_agent_open(
    defaults: Option<&ProjectChatDefaults>,
    agent: Option<&str>,
    model: Option<&str>,
    limited: LimitProbe,
) -> (Option<String>, Option<String>) {
    let (agent, model) = (agent.map(str::to_owned), model.map(str::to_owned));
    let Some(defaults) = defaults else { return (agent, model) };
    let Some(selection) = effective(defaults, limited) else { return (agent, model) };
    match agent {
        None => (Some(selection.agent_id), model.or(selection.model)),
        Some(asked) if model.is_none() && asked == selection.agent_id => (Some(asked), selection.model),
        Some(asked) => (Some(asked), model),
    }
}

/// O que a tela recebe ao abrir uma conversa nova num projeto.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveDefaults {
    pub defaults: Option<ProjectChatDefaults>,
    pub selection: Option<EffectiveSelection>,
}

fn limited_probe<'a>(conn: &'a Connection, account_id: Option<&'a str>, now: i64) -> impl Fn(&str) -> Option<i64> + 'a {
    move |agent_id| crate::conversa::limite::limited_until(conn, agent_id, account_id, now)
}

/// Para quem abre conversa sem tela: lê os padrões e devolve o agente e o modelo a usar. Erro de leitura não
/// impede abrir: vale o que foi pedido.
pub(crate) fn inherit_for_open(db: &DbConnection, cwd: &str, agent: Option<&str>, model: Option<&str>) -> (Option<String>, Option<String>) {
    let Ok(conn) = db.lock() else { return (agent.map(str::to_owned), model.map(str::to_owned)) };
    let defaults = read(&conn, cwd).ok().flatten();
    let probe = limited_probe(&conn, None, crate::util::now_ts());
    inherit_for_agent_open(defaults.as_ref(), agent, model, &probe)
}

#[tauri::command]
pub fn chat_project_defaults_get(db: State<'_, DbConnection>, cwd: String) -> Result<Option<ProjectChatDefaults>, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    read(&conn, &cwd)
}

/// Todos os padrões gravados. Um registro que não lê (arquivo editado à mão) some da lista, sem derrubar os outros.
pub(crate) fn read_all(conn: &Connection) -> Result<Vec<ProjectChatDefaults>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key LIKE ?1 LIMIT ?2")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![format!("{SETTINGS_PREFIX}%"), MAX_PROJECTS as i64], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .filter_map(|raw| serde_json::from_str::<ProjectChatDefaults>(&raw).ok())
        .filter_map(|defaults| validate(defaults).ok())
        .collect())
}

/// Todos os padrões gravados (a tela os lê ao abrir e guarda um espelho).
#[tauri::command]
pub fn chat_project_defaults_list(db: State<'_, DbConnection>) -> Result<Vec<ProjectChatDefaults>, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    read_all(&conn)
}

/// O que valeria numa conversa nova agora: os padrões e o agente/modelo já com o reserva aplicado.
#[tauri::command]
pub fn chat_project_defaults_effective(
    db: State<'_, DbConnection>,
    cwd: String,
    account_id: Option<String>,
) -> Result<EffectiveDefaults, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    let defaults = read(&conn, &cwd)?;
    let probe = limited_probe(&conn, account_id.as_deref(), crate::util::now_ts());
    let selection = defaults.as_ref().and_then(|defaults| effective(defaults, &probe));
    Ok(EffectiveDefaults { defaults, selection })
}

/// Grava os padrões do projeto (substitui o registro). Um registro vazio apaga a chave, como «Redefinir».
pub(crate) fn write(conn: &Connection, defaults: ProjectChatDefaults) -> Result<Option<ProjectChatDefaults>, String> {
    let defaults = validate(defaults)?;
    let key = setting_key(&defaults.cwd);
    if defaults.is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?1", [&key]).map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let value = serde_json::to_string(&defaults).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(Some(defaults))
}

pub(crate) fn remove(conn: &Connection, cwd: &str) -> Result<(), String> {
    let cwd = normalize_cwd(cwd)?;
    conn.execute("DELETE FROM settings WHERE key = ?1", [setting_key(&cwd)]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn chat_project_defaults_save(db: State<'_, DbConnection>, defaults: ProjectChatDefaults) -> Result<Option<ProjectChatDefaults>, String> {
    crate::database::wait_until_db_ready();
    let conn = db.lock().map_err(|error| error.to_string())?;
    write(&conn, defaults)
}

#[tauri::command]
pub fn chat_project_defaults_clear(db: State<'_, DbConnection>, cwd: String) -> Result<(), String> {
    crate::database::wait_until_db_ready();
    let conn = db.lock().map_err(|error| error.to_string())?;
    remove(&conn, &cwd)
}

#[cfg(test)]
mod test;
