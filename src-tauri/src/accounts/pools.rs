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
pub const MAX_POOLS: usize = 20;
const MAX_NAME: usize = 30;
/// El prefijo con que se pide un pool donde iría una cuenta.
pub const PREFIX: &str = "pool:";

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
    /// Al fallar por límite de uso, permite reintentar una vez dentro de este pool.
    /// Los pools guardados antes de esta opción siguen desactivados.
    #[serde(default)]
    pub failover: bool,
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

// ── Guardado ────────────────────────────────────────────────────────

pub fn load(db: &DbConnection) -> Vec<Pool> {
    crate::database::get_setting(db, POOLS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(db: &DbConnection, pools: &[Pool]) -> Result<(), String> {
    let raw = serde_json::to_string(pools).map_err(|e| e.to_string())?;
    crate::database::set_setting(db, POOLS_KEY, &raw)
}

fn cursors(db: &DbConnection) -> std::collections::HashMap<String, usize> {
    crate::database::get_setting(db, CURSORS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// El pool listo para elegir, y avanza su turno: cada pedido de `round_robin` arranca un
/// lugar más allá que el anterior (el ruteo salta las que no se pueden usar).
pub fn spec_for(db: &DbConnection, wanted: &str) -> Result<PoolSpec, String> {
    let pools = load(db);
    let pool = find(&pools, wanted)?;
    let mut turns = cursors(db);
    let start = turns.get(&pool.id).copied().unwrap_or(0);
    if pool.strategy == Strategy::RoundRobin {
        turns.insert(pool.id.clone(), start.wrapping_add(1) % pool.members.len().max(1));
        if let Ok(raw) = serde_json::to_string(&turns) {
            let _ = crate::database::set_setting(db, CURSORS_KEY, &raw);
        }
    }
    Ok(PoolSpec {
        id: pool.id.clone(),
        name: pool.name.clone(),
        agent_id: pool.agent_id.clone(),
        members: pool.members.clone(),
        strategy: pool.strategy,
        start,
        failover: pool.failover,
    })
}

#[cfg(test)]
mod test;
