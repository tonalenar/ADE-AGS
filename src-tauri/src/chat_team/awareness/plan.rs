//! O que segura um item da fila: as condições dele, o limite de agentes, a carga e a sobreposição de áreas.
//! Pura. Vazio = a ADE pode lançar agora.

use super::gate::{self, Busy};
use super::overlap;
use super::queue::{self, Ctx, Item};

/// Uma tarefa em andamento que declarou as áreas em que mexe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub name: String,
    pub areas: Vec<String>,
}

pub struct World<'a> {
    pub ctx: Ctx<'a>,
    pub limit: usize,
    /// Os agentes do orquestrador do item que já trabalham, mais os lançados nesta mesma passada.
    pub active: &'a [Busy],
    pub claims: &'a [Claim],
}

pub fn hold_reasons(item: &Item, world: &World) -> Vec<String> {
    let mut reasons = queue::waiting_on(item, &world.ctx);
    if let Err(refusal) = gate::check(world.limit, world.active, world.ctx.load) {
        match refusal.reason {
            gate::REASON_LIMIT => {
                let names: Vec<&str> = world.active.iter().map(|a| a.name.as_str()).collect();
                reasons.push(format!("limite de {} agentes simultâneos cheio ({})", world.limit, names.join(", ")));
            }
            // Quem já espera a carga baixar não ganha um segundo motivo igual.
            _ if item.conditions.iter().any(|c| c.kind == queue::KIND_LOAD_LOW) => {}
            _ => reasons.push(format!("máquina sobrecarregada (load {:.1}, limite {:.0})", world.ctx.load.load1, world.ctx.load.threshold)),
        }
    }
    for claim in world.claims {
        let shared = overlap::shared(&item.areas, &claim.areas);
        if !shared.is_empty() {
            reasons.push(format!("mesma área que {} ({})", claim.name, shared.join(", ")));
        }
    }
    reasons
}
