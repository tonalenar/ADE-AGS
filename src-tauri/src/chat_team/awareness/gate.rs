//! A porta de entrada de um agente novo: o limite de agentes trabalhando ao mesmo tempo e a carga da máquina.
//! Pura. Quem chama lê o banco e mede a carga; aqui só se decide e se escreve o motivo da recusa.

use serde::Serialize;

use super::load::Load;

pub const DEFAULT_MAX_AGENTS: usize = 3;
pub const MIN_MAX_AGENTS: usize = 1;
pub const MAX_MAX_AGENTS: usize = 12;
/// A configuração (tabela `settings`): quantos agentes de um orquestrador podem trabalhar ao mesmo tempo.
pub const SETTING_MAX_AGENTS: &str = "team.max_agents";

pub const REASON_LIMIT: &str = "agent_limit";
pub const REASON_LOAD: &str = "machine_overloaded";
pub const REASON_OVERLAP: &str = "area_overlap";

/// O limite pela configuração. Vazio, lixo ou fora da faixa volta ao padrão ou à borda mais próxima.
pub fn limit_from(raw: Option<&str>) -> usize {
    match raw.and_then(|text| text.trim().parse::<i64>().ok()) {
        Some(n) => (n.max(MIN_MAX_AGENTS as i64) as usize).min(MAX_MAX_AGENTS),
        None => DEFAULT_MAX_AGENTS,
    }
}

/// Um agente que está trabalhando agora.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Busy {
    pub member: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason: &'static str,
    pub message: String,
}

/// Pode lançar mais um agente? `active` são os que já trabalham para o mesmo orquestrador.
pub fn check(limit: usize, active: &[Busy], load: &Load) -> Result<(), Refusal> {
    if active.len() >= limit {
        let names: Vec<&str> = active.iter().map(|a| a.name.as_str()).collect();
        return Err(Refusal {
            reason: REASON_LIMIT,
            message: format!(
                "o limite de {limit} agentes simultâneos está cheio ({}). Enfileire a tarefa com `ags team queue add --after <agente> --task \"...\"` e espere o aviso de conclusão; explique ao usuário que está aguardando um agente terminar.",
                names.join(", ")
            ),
        });
    }
    if load.overloaded {
        return Err(Refusal {
            reason: REASON_LOAD,
            message: format!(
                "a máquina está sobrecarregada: load {:.1} em {} núcleos (limite {:.0}), {} compilação(ões) cargo em andamento. Enfileire com `ags team queue add --when-load-low --task \"...\"`; a ADE lança quando a carga baixar e avisa você. Explique ao usuário que está esperando a carga cair.",
                load.load1, load.cores, load.threshold, load.builds
            ),
        });
    }
    Ok(())
}
