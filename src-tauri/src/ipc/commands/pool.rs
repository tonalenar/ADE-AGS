//! Pools de cuentas: `ags pools | pool create|update|delete`. Ver `crate::accounts::pools`.
//!
//! Un pool agrupa cuentas de una misma TUI y reparte entre ellas por una estrategia; se pide
//! con `pool:<nombre>` donde iría una cuenta (`ags tab create --agent claude-code --account
//! pool:Trabajo`, el `account` de una tarea de un plan o de un miembro de un Squad).
//!
//! No guarda ningún secreto: solo nombra cuentas que ya existen.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::accounts::pools::{self, Pool, Strategy};
use crate::database::DbConnection;
use crate::ipc::protocol::{arg_str, arg_str_opt};

pub const CHANGED_EVENT: &str = "cc-pools-changed";

fn db(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(app.try_state::<DbConnection>().ok_or("o banco de dados não está disponível")?.inner().clone())
}

/// Las cuentas creadas: `(id, agent_id, nombre)`.
fn created_accounts(db: &DbConnection) -> Result<Vec<(String, String, String)>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, agent_id, name FROM agent_accounts ORDER BY agent_id, name").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Los nombres que se escriben para la cuenta del sistema (la principal de la TUI).
fn is_system_word(word: &str) -> bool {
    matches!(word.trim().to_lowercase().as_str(), "principal" | "system" | "sistema" | "default")
}

/// `principal,trabajo` → ids (la del sistema es `None`), comprobando que sean de ese agente.
pub(crate) fn members_from_names(
    accounts: &[(String, String, String)],
    agent_id: &str,
    raw: &str,
) -> Result<Vec<Option<String>>, String> {
    let mut out = Vec::new();
    for word in raw.split(',').map(str::trim).filter(|w| !w.is_empty()) {
        if is_system_word(word) {
            out.push(None);
            continue;
        }
        out.push(Some(super::agents::match_account_id(accounts, agent_id, word)?));
    }
    Ok(out)
}

fn describe(pool: &Pool, accounts: &[(String, String, String)]) -> Value {
    let names: Vec<String> = pool
        .members
        .iter()
        .map(|m| match m {
            None => "principal".to_string(),
            Some(id) => accounts.iter().find(|(aid, _, _)| aid == id).map(|(_, _, n)| n.clone()).unwrap_or_else(|| format!("{id} (apagada)")),
        })
        .collect();
    json!({
        "id": pool.id,
        "name": pool.name,
        "agent": pool.agent_id,
        "strategy": pool.strategy.as_str(),
        "accounts": names,
        "failover": pool.failover,
        "paused": pool.paused,
    })
}

pub(super) fn pool_list(app: &AppHandle, _args: &Value) -> Result<Value, String> {
    let db = db(app)?;
    let accounts = created_accounts(&db)?;
    Ok(json!({ "pools": pools::load(&db).iter().map(|p| describe(p, &accounts)).collect::<Vec<_>>() }))
}

pub(super) fn pool_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let db = db(app)?;
    let name = arg_str(args, "name")?;
    let agent = arg_str(args, "agent")?;
    let accounts = created_accounts(&db)?;
    let members = members_from_names(&accounts, &agent, &arg_str(args, "accounts")?)?;
    let strategy = arg_str_opt(args, "strategy").map(|s| Strategy::parse(&s)).transpose()?.unwrap_or_default();
    let paused = args.get("paused").and_then(Value::as_bool).unwrap_or(false);
    let failover = args.get("failover").and_then(Value::as_bool).unwrap_or(!paused);

    let mut all = pools::load(&db);
    let pairs: Vec<(String, String)> = accounts.iter().map(|(id, a, _)| (id.clone(), a.clone())).collect();
    let name = pools::validate(&all, &name, &agent, &members, &pairs)?;
    let pool = Pool {
        id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        name,
        agent_id: agent,
        members,
        strategy,
        failover,
        paused,
    };
    all.push(pool.clone());
    pools::save(&db, &all)?;
    let _ = app.emit(CHANGED_EVENT, &pool.id);
    Ok(json!({ "created": describe(&pool, &accounts) }))
}

/// Atualiza nome, membros, ordem, estratégia ou pausa de um pool, preservando `pool.id`.
pub(super) fn pool_update_ipc(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let db = db(app)?;
    let wanted = arg_str_opt(args, "id").or_else(|| arg_str_opt(args, "name"))
        .ok_or("Informe o nome ou id do pool a editar.")?;
    let existing = pools::load(&db);
    let current = pools::find(&existing, &wanted)?.clone();
    let accounts = created_accounts(&db)?;
    let pairs: Vec<(String, String)> = accounts.iter().map(|(id, a, _)| (id.clone(), a.clone())).collect();

    let next_name = arg_str_opt(args, "newName")
        .or_else(|| arg_str_opt(args, "new_name"))
        .or_else(|| if arg_str_opt(args, "id").is_some() { arg_str_opt(args, "name") } else { None })
        .unwrap_or_else(|| current.name.clone());
    let next_members = match arg_str_opt(args, "accounts") {
        Some(raw) => members_from_names(&accounts, &current.agent_id, &raw)?,
        None => current.members.clone(),
    };
    let next_strategy = match arg_str_opt(args, "strategy") {
        Some(raw) => Strategy::parse(&raw)?,
        None => current.strategy,
    };
    let mut updated = pools::update(&db, &current.id, &next_name, next_members, next_strategy, &pairs)?;
    if let Some(paused) = args.get("paused").and_then(|v| v.as_bool().or_else(|| v.as_str().and_then(|s| s.parse::<bool>().ok()))) {
        updated = pools::set_paused(&db, &updated.id, paused)?;
    }
    let _ = app.emit(CHANGED_EVENT, &updated.id);
    Ok(json!({ "updated": describe(&updated, &accounts) }))
}

pub(super) fn pool_delete(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let db = db(app)?;
    let mut all = pools::load(&db);
    let id = pools::find(&all, &arg_str(args, "name")?)?.id.clone();
    let at = all.iter().position(|p| p.id == id).ok_or("O pool não existe mais.")?;
    let removed = all.remove(at);
    pools::save(&db, &all)?;
    let _ = app.emit(CHANGED_EVENT, &id);
    Ok(json!({ "deleted": removed.name }))
}

// ── Para la pantalla ────────────────────────────────────────────────

#[tauri::command(async)]
pub fn pool_list_all(app: AppHandle) -> Result<Vec<Pool>, String> {
    Ok(pools::load(&db(&app)?))
}

#[tauri::command(async)]
pub fn pool_save_new(
    app: AppHandle,
    name: String,
    agent_id: String,
    members: Vec<Option<String>>,
    strategy: String,
    failover: Option<bool>,
    paused: Option<bool>,
) -> Result<Pool, String> {
    let db = db(&app)?;
    let accounts = created_accounts(&db)?;
    let pairs: Vec<(String, String)> = accounts.iter().map(|(id, a, _)| (id.clone(), a.clone())).collect();
    let mut all = pools::load(&db);
    let name = pools::validate(&all, &name, &agent_id, &members, &pairs)?;
    let paused = paused.unwrap_or(false);
    let failover = failover.unwrap_or(!paused);
    let pool = Pool {
        id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        name,
        agent_id,
        members,
        strategy: Strategy::parse(&strategy)?,
        failover,
        paused,
    };
    all.push(pool.clone());
    pools::save(&db, &all)?;
    let _ = app.emit(CHANGED_EVENT, &pool.id);
    Ok(pool)
}

/// Atualiza nome, membros, ordem e estratégia de um pool existente, preservando o `pool.id`.
#[tauri::command(async)]
pub fn pool_update(
    app: AppHandle,
    id: String,
    name: String,
    members: Vec<Option<String>>,
    strategy: String,
) -> Result<Pool, String> {
    let db = db(&app)?;
    let accounts = created_accounts(&db)?;
    let pairs: Vec<(String, String)> = accounts.iter().map(|(id, a, _)| (id.clone(), a.clone())).collect();
    let updated = pools::update(&db, &id, &name, members, Strategy::parse(&strategy)?, &pairs)?;
    let _ = app.emit(CHANGED_EVENT, &updated.id);
    Ok(updated)
}

/// La cuenta que elige ese pool ahora, para abrir una tab desde la pantalla (`None` = la del sistema).
#[tauri::command(async)]
pub fn pool_pick(app: AppHandle, agent_id: String, pool: String) -> Result<Option<String>, String> {
    super::agents::resolve_pool_account(&app, &agent_id, &pool)
}

/// `pool:<nome>` que um integrante/subagente novo usa quando ninguém escolheu conta (o pool ativo do agente, por nome
/// e id), ou `None` se o agente não tem pool ativo com 2+ contas.
#[tauri::command(async)]
pub fn pool_default_ref(app: AppHandle, agent_id: String) -> Result<Option<String>, String> {
    let db = db(&app)?;
    let Some(pool_ref) = crate::conversa::pool::default_pool_ref(&db, &agent_id) else { return Ok(None) };
    // Só devolve o pool se ele escolheria uma conta agora (sem avançar o cursor): o integrante não nasce com erro.
    let roster = crate::runs::roster::snapshot(&db, false)?;
    let pickable = pools::pool_ref(&pool_ref).and_then(|name| pools::spec_preview(&db, name).ok()).is_some_and(|spec| {
        roster.agents.iter().find(|a| a.agent_id == agent_id).is_some_and(|agent| {
            crate::runs::routing::pick_in_pool(agent, &spec, crate::util::now_ts()).is_ok()
        })
    });
    Ok(pickable.then_some(pool_ref))
}

/// Prévia somente leitura de qual conta cada pool escolheria agora, reaproveitando `routing::pick_in_pool`
/// sem avançar cursor nem duplicar a regra de escolha no frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolPickPreview {
    pub pool_id: String,
    /// `Some(None)` = conta principal/do sistema; `Some(Some(id))` = conta extra; `None` = nenhuma disponível.
    pub account_id: Option<Option<String>>,
    pub available: bool,
    pub swaps_today: usize,
}

#[tauri::command(async)]
pub fn pool_preview_picks(app: AppHandle) -> Result<Vec<PoolPickPreview>, String> {
    let db = db(&app)?;
    let all = pools::load(&db);
    let roster = crate::runs::roster::snapshot(&db, false)?;
    let now = crate::util::now_ts();
    let mut out = Vec::with_capacity(all.len());
    for pool in all {
        let swaps_today = crate::runs::pool_failover::swaps_in_last_day(&db, &pool.id, now);
        let picked = pools::spec_preview(&db, &pool.id).ok().and_then(|spec| {
            let agent = roster.agents.iter().find(|a| a.agent_id == pool.agent_id)?;
            crate::runs::routing::pick_in_pool(agent, &spec, now).ok().map(|(id, _)| id)
        });
        out.push(PoolPickPreview {
            pool_id: pool.id,
            available: picked.is_some(),
            account_id: picked,
            swaps_today,
        });
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn pool_remove(app: AppHandle, id: String) -> Result<(), String> {
    let db = db(&app)?;
    let mut all = pools::load(&db);
    let at = all.iter().position(|p| p.id == id).ok_or("O pool não existe mais.")?;
    all.remove(at);
    pools::save(&db, &all)?;
    let _ = app.emit(CHANGED_EVENT, &id);
    Ok(())
}

#[tauri::command(async)]
pub fn pool_set_failover(app: AppHandle, id: String, enabled: bool) -> Result<Pool, String> {
    let db = db(&app)?;
    let updated = pools::set_paused(&db, &id, !enabled)?;
    let _ = app.emit(CHANGED_EVENT, &id);
    Ok(updated)
}

#[tauri::command(async)]
pub fn pool_set_paused(app: AppHandle, id: String, paused: bool) -> Result<Pool, String> {
    let db = db(&app)?;
    let updated = pools::set_paused(&db, &id, paused)?;
    let _ = app.emit(CHANGED_EVENT, &id);
    Ok(updated)
}

#[cfg(test)]
mod test {
    use super::*;

    fn accounts() -> Vec<(String, String, String)> {
        vec![
            ("id-a".into(), "claude-code".into(), "Trabajo".into()),
            ("id-b".into(), "claude-code".into(), "Casa".into()),
            ("id-c".into(), "codex".into(), "Otra".into()),
        ]
    }

    #[test]
    fn los_nombres_se_vuelven_ids_y_principal_es_la_del_sistema() {
        let m = members_from_names(&accounts(), "claude-code", "principal, trabajo ,Casa").unwrap();
        assert_eq!(m, vec![None, Some("id-a".into()), Some("id-b".into())]);
        assert!(members_from_names(&accounts(), "claude-code", "").unwrap().is_empty());
    }

    #[test]
    fn una_cuenta_de_otra_tui_o_inexistente_falla_diciendo_cual() {
        assert!(members_from_names(&accounts(), "claude-code", "Otra").unwrap_err().contains("'codex'"));
        assert!(members_from_names(&accounts(), "claude-code", "nada").unwrap_err().contains("Tem"));
    }

    #[test]
    fn la_descripcion_pone_nombres_y_marca_las_apagadas() {
        let pool = Pool { id: "p".into(), name: "T".into(), agent_id: "claude-code".into(), members: vec![None, Some("id-a".into()), Some("zz".into())], strategy: Strategy::Sticky, failover: false, paused: false };
        let d = describe(&pool, &accounts());
        assert_eq!(d["accounts"], json!(["principal", "Trabajo", "zz (apagada)"]));
        assert_eq!(d["strategy"], "sticky");
        assert_eq!(d["paused"], false);
    }
}
