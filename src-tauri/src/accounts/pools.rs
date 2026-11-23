//! Pools de cuentas: un grupo con nombre de cuentas de la MISMA TUI y una estrategia para
//! elegir una cada vez.
//!
//! Sin pools, una tarea o una tab usa una cuenta fija o `Auto` (la menos cargada de todas las
//! de esa TUI). Un pool sirve para repartir entre un subconjunto —las dos cuentas de trabajo,
//! no la personal— con la regla que se quiera:
//!
//! - **`least_used`**: la que tiene más ventana libre ahora (en escalones de 10 %), como `Auto`
//!   pero solo entre las del pool.
//! - **`round_robin`**: una tras otra, para repartir parejo aunque el cupo no se vea.
//! - **`sticky`**: siempre la primera de la lista que se pueda usar, y la siguiente solo cuando
//!   esa no puede (sin sesión, sin cupo, al máximo). Es "la principal con respaldo".
//!
//! Se piden con `pool:<nombre>` donde iría una cuenta (`ags tab create --account pool:Trabajo`,
//! `account` de una tarea de un plan, de un miembro de un Squad). Se guardan en los ajustes.
//!
//! Este módulo es el modelo y el guardado; elegir la cuenta es de `runs::routing`, que ya sabe
//! qué cuentas tienen cupo y sesión.

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;

const POOLS_KEY: &str = "accounts.pools";
const CURSORS_KEY: &str = "accounts.pool_cursors";
/// Modo global de troca quando a cota de uma conta acaba (vale para conversas e tarefas em pool).
pub const MODE_KEY: &str = "chat.pool.mode";
pub const MAX_POOLS: usize = 20;
const MAX_NAME: usize = 30;
/// El prefijo con que se pide un pool donde iría una cuenta.
pub const PREFIX: &str = "pool:";
/// Código estruturado de erro quando se tenta usar um pool que ficou sem contas.
pub const EMPTY_POOL_CODE: &str = "poolEmpty";

/// Payload JSON estruturado para erro de pool vazio, traduzido no frontend nos 3 catálogos
/// (segue o padrão estruturado de mensagens de pool do #415).
pub fn empty_pool_error(pool_name: &str) -> String {
    serde_json::json!({
        "code": EMPTY_POOL_CODE,
        "pool": pool_name,
    })
    .to_string()
}

/// Política global quando a cota de uma conta em um pool acaba (conversas e tarefas em segundo plano).
/// Sem valor salvo, o padrão é `Ask` ("Perguntar").
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PoolMode {
    Off,
    #[default]
    Ask,
    Auto,
}

impl PoolMode {
    /// Interpreta o valor guardado em `settings`.
    /// - Ausente ou vazio: `Ask` ("Perguntar", novo padrão unificado).
    /// - `"off"`, `"ask"`, `"auto"`: respeita o valor salvo.
    /// - Valor desconhecido: falha fechado em `Off`.
    pub fn parse_setting(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            None | Some("") => PoolMode::Ask,
            Some("off") => PoolMode::Off,
            Some("ask") => PoolMode::Ask,
            Some("auto") => PoolMode::Auto,
            Some(_) => PoolMode::Off,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PoolMode::Off => "off",
            PoolMode::Ask => "ask",
            PoolMode::Auto => "auto",
        }
    }
}

pub fn load_mode(db: &DbConnection) -> PoolMode {
    let raw = crate::database::get_setting(db, MODE_KEY).ok().flatten();
    PoolMode::parse_setting(raw.as_deref())
}

pub fn save_mode(db: &DbConnection, mode: PoolMode) -> Result<(), String> {
    crate::database::set_setting(db, MODE_KEY, mode.as_str())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    #[default]
    LeastUsed,
    RoundRobin,
    Sticky,
}

impl Strategy {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_lowercase().replace('-', "_").as_str() {
            "least_used" | "leastused" | "menos_usada" => Ok(Strategy::LeastUsed),
            "round_robin" | "roundrobin" | "rotativo" => Ok(Strategy::RoundRobin),
            "sticky" | "principal" | "fija" => Ok(Strategy::Sticky),
            other => Err(format!("A estratégia '{other}' não existe. Use least-used, round-robin ou sticky.")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::LeastUsed => "least_used",
            Strategy::RoundRobin => "round_robin",
            Strategy::Sticky => "sticky",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub id: String,
    pub name: String,
    pub agent_id: String,
    /// Ids de cuenta, en orden (el orden manda en `sticky` y desempata en las otras).
    /// `None` = la cuenta del sistema (la principal de esa TUI).
    pub members: Vec<Option<String>>,
    #[serde(default)]
    pub strategy: Strategy,
    /// Campo legado de opt-in por pool. Mantido para migração aditiva sem perda de dados:
    /// pools salvos antes de `paused` com `failover: false` carregam com `paused: true`.
    #[serde(default)]
    pub failover: bool,
    /// Pausa as trocas neste pool (substitui o antigo `failover` por pool). Default: `false`.
    #[serde(default)]
    pub paused: bool,
}

/// Identidad del pool que originó una tarea. Se guarda en `settings`, fuera de la tabla
/// `tasks`, para que el scheduler respete el mismo pool aunque la tarea se ejecute después.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PoolOrigin {
    pub id: String,
    pub name: String,
    pub agent_id: String,
}

/// Un pool tal como lo ve el ruteo al elegir: sin más que lo necesario, y con dónde arranca
/// el turno de `round_robin`.
#[derive(Debug, Clone, PartialEq)]
pub struct PoolSpec {
    pub id: String,
    pub name: String,
    pub agent_id: String,
    pub members: Vec<Option<String>>,
    pub strategy: Strategy,
    pub start: usize,
    pub failover: bool,
    pub paused: bool,
}

/// `pool:Trabajo` → `Trabajo`.
pub fn pool_ref(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    trimmed
        .get(..PREFIX.len())
        .filter(|p| p.eq_ignore_ascii_case(PREFIX))
        .map(|_| trimmed[PREFIX.len()..].trim())
        .filter(|n| !n.is_empty())
}

pub fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("O pool precisa de um nome.".into());
    }
    if name.chars().count() > MAX_NAME || name.chars().any(char::is_control) || name.contains(':') {
        return Err(format!("O nome do pool tem até {MAX_NAME} caracteres, sem ':' nem caracteres de controle."));
    }
    Ok(name)
}

/// Valida un pool nuevo contra los existentes. `accounts` son las cuentas creadas, como
/// `(id, agent_id)`; la del sistema (`None`) vale para cualquier TUI.
pub fn validate(
    existing: &[Pool],
    name: &str,
    agent_id: &str,
    members: &[Option<String>],
    accounts: &[(String, String)],
) -> Result<String, String> {
    let name = clean_name(name)?;
    if existing.len() >= MAX_POOLS {
        return Err(format!("Já há {MAX_POOLS} pools, o máximo."));
    }
    if existing.iter().any(|p| p.name.to_lowercase() == name.to_lowercase()) {
        return Err(format!("Já existe um pool chamado '{name}'."));
    }
    if members.len() < 2 {
        return Err("Um pool precisa de pelo menos 2 contas (para uma só, use a própria conta).".into());
    }
    for (i, m) in members.iter().enumerate() {
        if members[..i].contains(m) {
            return Err("Uma conta aparece duas vezes no pool.".into());
        }
        if let Some(id) = m {
            match accounts.iter().find(|(aid, _)| aid == id) {
                None => return Err(format!("A conta '{id}' não existe.")),
                Some((_, a)) if a != agent_id => return Err(format!("A conta '{id}' é de '{a}', não de '{agent_id}': um pool é de uma TUI só.")),
                Some(_) => {}
            }
        }
    }
    Ok(name)
}

/// Valida a edição de um pool existente (preserva o `id`, permite manter o mesmo nome).
pub fn validate_update(
    existing: &[Pool],
    id: &str,
    name: &str,
    agent_id: &str,
    members: &[Option<String>],
    accounts: &[(String, String)],
) -> Result<String, String> {
    let name = clean_name(name)?;
    if existing.iter().any(|p| p.id != id && p.name.to_lowercase() == name.to_lowercase()) {
        return Err(format!("Já existe um pool chamado '{name}'."));
    }
    if members.len() < 2 {
        return Err("Um pool precisa de pelo menos 2 contas (para uma só, use a própria conta).".into());
    }
    for (i, m) in members.iter().enumerate() {
        if members[..i].contains(m) {
            return Err("Uma conta aparece duas vezes no pool.".into());
        }
        if let Some(aid_req) = m {
            match accounts.iter().find(|(aid, _)| aid == aid_req) {
                None => return Err(format!("A conta '{aid_req}' não existe.")),
                Some((_, a)) if a != agent_id => {
                    return Err(format!(
                        "A conta '{aid_req}' é de '{a}', não de '{agent_id}': um pool é de uma TUI só."
                    ));
                }
                Some(_) => {}
            }
        }
    }
    Ok(name)
}

/// Un pool por nombre (sin mayúsculas) o por id.
pub fn find<'a>(pools: &'a [Pool], wanted: &str) -> Result<&'a Pool, String> {
    let needle = wanted.trim().to_lowercase();
    pools
        .iter()
        .find(|p| p.id == wanted || p.name.to_lowercase() == needle)
        .ok_or_else(|| {
            if pools.is_empty() {
                format!("Não existe o pool '{wanted}': você ainda não criou nenhum (`ags pool create`).")
            } else {
                format!("Não existe o pool '{wanted}'. Pools: {}.", pools.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "))
            }
        })
}

/// Ordem estável para escolher entre pools candidatos: nome sem caixa e depois o id.
fn stable_order(a: &&Pool, b: &&Pool) -> std::cmp::Ordering {
    a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id))
}

/// O pool que cobre uma conta FIXA (a conversa/tarefa não escolheu `pool:<nome>`): do mesmo agente, não pausado,
/// com a conta como membro e ao menos outra conta para trocar. Com mais de um candidato vale o primeiro por nome
/// (sem caixa) e id, sempre o mesmo, independente da ordem em que os pools foram salvos.
pub fn implicit_pool<'a>(pools: &'a [Pool], agent_id: &str, account: &Option<String>) -> Option<&'a Pool> {
    pools
        .iter()
        .filter(|p| p.agent_id == agent_id && !p.paused && p.members.len() > 1 && p.members.contains(account))
        .min_by(stable_order)
}

/// O pool que um subagente/integrante novo usa quando ninguém escolheu conta: o primeiro (por nome e id) do agente
/// que não está pausado e tem 2+ contas.
pub fn default_pool_for_agent<'a>(pools: &'a [Pool], agent_id: &str) -> Option<&'a Pool> {
    pools
        .iter()
        .filter(|p| p.agent_id == agent_id && !p.paused && p.members.len() > 1)
        .min_by(stable_order)
}

// ── Guardado ────────────────────────────────────────────────────────

/// Lê os pools do JSON salvo aplicando a migração aditiva:
/// pools gravados antes do campo `paused` que tinham `failover: false` (ou ausente) continuam
/// pausados (`paused: true`) para não iniciar troca automática inesperada em tarefas.
pub fn parse_pools_migrated(raw: &str) -> Vec<Pool> {
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let has_paused = item.get("paused").is_some();
        if let Ok(mut pool) = serde_json::from_value::<Pool>(item) {
            if !has_paused && !pool.failover {
                pool.paused = true;
            }
            out.push(pool);
        }
    }
    out
}

/// Lê os pools diretamente de uma conexão já aberta (evita re-travar `DbConnection`).
pub(crate) fn load_with_conn(conn: &rusqlite::Connection) -> Vec<Pool> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [POOLS_KEY], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .map(|raw| parse_pools_migrated(&raw))
    .unwrap_or_default()
}

pub fn load(db: &DbConnection) -> Vec<Pool> {
    crate::database::get_setting(db, POOLS_KEY)
        .ok()
        .flatten()
        .map(|raw| parse_pools_migrated(&raw))
        .unwrap_or_default()
}

pub fn save(db: &DbConnection, pools: &[Pool]) -> Result<(), String> {
    let raw = serde_json::to_string(pools).map_err(|e| e.to_string())?;
    crate::database::set_setting(db, POOLS_KEY, &raw)
}

/// Remove referências a uma conta apagada de todos os pools em memória e devolve os nomes dos pools afetados.
pub fn remove_account_refs(pools: &mut [Pool], account_id: &str) -> Vec<String> {
    let mut affected = Vec::new();
    for pool in pools.iter_mut() {
        let before = pool.members.len();
        pool.members.retain(|m| m.as_deref() != Some(account_id));
        if pool.members.len() != before {
            affected.push(pool.name.clone());
        }
    }
    affected
}

/// Remove a referência de uma conta apagada dos pools salvos e devolve os nomes dos pools alterados (M-1).
pub fn remove_account_from_pools(db: &DbConnection, account_id: &str) -> Result<Vec<String>, String> {
    let mut all = load(db);
    let affected = remove_account_refs(&mut all, account_id);
    if !affected.is_empty() {
        save(db, &all)?;
    }
    Ok(affected)
}

/// Atualiza nome, membros, ordem e estratégia de um pool, preservando `pool.id` e `agent_id`.
pub fn update(
    db: &DbConnection,
    id: &str,
    name: &str,
    members: Vec<Option<String>>,
    strategy: Strategy,
    accounts: &[(String, String)],
) -> Result<Pool, String> {
    let mut all = load(db);
    let idx = all.iter().position(|p| p.id == id).ok_or("O pool não existe mais.")?;
    let agent_id = all[idx].agent_id.clone();
    let clean = validate_update(&all, id, name, &agent_id, &members, accounts)?;
    all[idx].name = clean;
    all[idx].members = members;
    all[idx].strategy = strategy;
    let updated = all[idx].clone();
    save(db, &all)?;
    Ok(updated)
}

/// Pausa ou retoma as trocas neste pool (espelha `failover = !paused` por compatibilidade).
pub fn set_paused(db: &DbConnection, id: &str, paused: bool) -> Result<Pool, String> {
    let mut all = load(db);
    let pool = all.iter_mut().find(|p| p.id == id).ok_or("O pool não existe mais.")?;
    pool.paused = paused;
    pool.failover = !paused;
    let updated = pool.clone();
    save(db, &all)?;
    Ok(updated)
}

fn cursors(db: &DbConnection) -> std::collections::HashMap<String, usize> {
    crate::database::get_setting(db, CURSORS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Serializa leitura + escolha + avanço do cursor de `round_robin`, evitando que duas chamadas
/// paralelas leiam o mesmo `start` ou sofram corrida de ler e gravar (M-6).
static ROUND_ROBIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Avança atomicamente o cursor monotônico de um pool em `settings` (sem módulo prematuro:
/// o módulo `% members.len()` é calculado apenas em `routing::pick_in_pool`).
pub fn advance_cursor(db: &DbConnection, pool_id: &str) -> Result<usize, String> {
    let mut conn = db.lock().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut turns: std::collections::HashMap<String, usize> = tx
        .query_row("SELECT value FROM settings WHERE key = ?1", [CURSORS_KEY], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let current = turns.get(pool_id).copied().unwrap_or(0);
    let next = current.wrapping_add(1);
    turns.insert(pool_id.to_string(), next);
    let raw = serde_json::to_string(&turns).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![CURSORS_KEY, raw],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(next)
}

/// Igual a `spec_for`, mas somente leitura: não avança o cursor de `round_robin`.
/// Usado pela tela de Pools para mostrar "Agora escolheria X" usando `routing::pick_in_pool`.
pub fn spec_preview(db: &DbConnection, wanted: &str) -> Result<PoolSpec, String> {
    let pools = load(db);
    let pool = find(&pools, wanted)?;
    let turns = cursors(db);
    let start = turns.get(&pool.id).copied().unwrap_or(0);
    Ok(PoolSpec {
        id: pool.id.clone(),
        name: pool.name.clone(),
        agent_id: pool.agent_id.clone(),
        members: pool.members.clone(),
        strategy: pool.strategy,
        start,
        failover: pool.failover,
        paused: pool.paused,
    })
}

/// Executa a escolha em memória (`pick`) com o cursor atual e só avança o cursor de `round_robin`
/// quando `pick` retorna `Ok`, tudo serializado sob trava (M-6). `pick` deve ser puro (o roster
/// já foi obtido antes, fora da trava).
pub fn with_pool_pick<T, F>(db: &DbConnection, wanted: &str, pick: F) -> Result<T, String>
where
    F: FnOnce(&PoolSpec) -> Result<T, String>,
{
    let _guard = ROUND_ROBIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let spec = spec_preview(db, wanted)?;
    let chosen = pick(&spec)?;
    if spec.strategy == Strategy::RoundRobin {
        let _ = advance_cursor(db, &spec.id);
    }
    Ok(chosen)
}

/// El pool listo para elegir, y avanza su turno: cada pedido de `round_robin` arranca un
/// lugar más allá que el anterior (el ruteo salta las que no se pueden usar).
/// Prefira [`with_pool_pick`] para só avançar quando a escolha suceder.
pub fn spec_for(db: &DbConnection, wanted: &str) -> Result<PoolSpec, String> {
    with_pool_pick(db, wanted, |spec| Ok(spec.clone()))
}

#[cfg(test)]
mod test;
