//! O modelo puro do time de agentes do modo chat: o que é um integrante, as políticas de permissão,
//! os papéis e os textos que o orquestrador e os integrantes recebem. Sem banco e sem app.

use serde::{Deserialize, Serialize};

/// O prefixo do id de uma conversa por protocolo quando ela entra no canvas, no `peer` e no time
/// (o mesmo do cartão da sidebar, `structured/model.ts::THREAD_PREFIX`). Sem ele, é o id de uma aba.
pub const THREAD_PREFIX: &str = "thread:";

/// Quantos integrantes um time aceita além do orquestrador. Mais que isso não se coordena por chat.
pub const MAX_MEMBERS: usize = 12;

const MAX_LABEL: usize = 60;
const MAX_TITLE: usize = 80;

/// O id da conversa por protocolo, se a referência for de uma (`thread:<id>`). Pura.
pub fn thread_id_of(member: &str) -> Option<&str> {
    member.strip_prefix(THREAD_PREFIX).filter(|id| !id.is_empty())
}

/// Por que o turno de uma conversa acabou SEM fala nova, para o `peer ask` não esperar o prazo inteiro.
/// Lê só o que ficou gravado: o `turnEnd` depois da última mensagem da pessoa/colega (erro, interrompido
/// ou concluído sem texto) ou o processo morto. `None` = ainda não dá para dizer (o turno pode nem ter
/// começado). Pura.
pub fn stopped_reason(items: &[crate::canal::timeline::Item], alive: bool) -> Option<String> {
    use crate::canal::timeline::ItemKind;
    let from = items.iter().rposition(|i| i.kind == ItemKind::User).map_or(0, |at| at + 1);
    let end = items[from..].iter().rev().find(|i| i.kind == ItemKind::TurnEnd);
    match end {
        Some(end) => Some(match (end.text.as_deref().map(str::trim).filter(|t| !t.is_empty()), end.interrupted) {
            (Some(error), _) => format!("O turno terminou com erro: {error}"),
            (None, Some(true)) => "O turno foi interrompido antes de haver resposta.".to_string(),
            (None, _) => "O turno terminou sem nenhuma resposta escrita.".to_string(),
        }),
        None if !alive => Some("A conversa fechou antes de responder.".to_string()),
        None => None,
    }
}

/// O que o integrante pode fazer sem perguntar. É a política do papel no time: vale para os pedidos
/// que chegam à caixa de Permissões e para a conversa nova aberta pelo time. Não muda os flags de
/// uma TUI que já estava aberta (lá a política só restringe, pela caixa).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    /// Só leitura: lê e responde; edição, comando que escreve e rede são negados.
    Read,
    /// Supervisionado ("pede tudo"): tudo que não é leitura passa pela pessoa.
    Ask,
    /// Aceita edições: edita sozinho na pasta dele; comandos e rede passam pela pessoa.
    Edits,
    /// Acesso total: sem perguntar (o risco alto continua indo à pessoa, ver `decide`).
    Full,
}

impl Policy {
    pub fn as_str(self) -> &'static str {
        match self {
            Policy::Read => "read",
            Policy::Ask => "ask",
            Policy::Edits => "edits",
            Policy::Full => "full",
        }
    }

    /// Aceita o id e os nomes que a pessoa (ou um agente) costuma escrever. Pura.
    pub fn parse(raw: &str) -> Result<Policy, String> {
        let key = crate::canvas::roles::slug(raw);
        Ok(match key.as_str() {
            "read" | "readonly" | "read-only" | "so-leitura" | "leitura" => Policy::Read,
            "ask" | "supervised" | "supervisionado" | "pede-tudo" | "default" => Policy::Ask,
            "edits" | "accept-edits" | "acceptedits" | "aceita-edicoes" | "aceitar-edicoes" => Policy::Edits,
            "full" | "full-access" | "acesso-total" | "bypass" => Policy::Full,
            _ => return Err(format!("Política desconhecida: '{raw}'. Use full, edits, ask ou read.")),
        })
    }
}

/// O tipo de pedido de permissão, como a caixa de Permissões classifica.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Read,
    Edit,
    Command,
    Network,
}

/// O que fazer com um pedido de permissão de um integrante.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    /// Vai para a pessoa.
    Ask,
    Deny,
}

/// O que a política decide sozinha. Risco alto nunca é automático: vai à pessoa (ou é negado, na só
/// leitura). Pura.
pub fn decide(policy: Policy, ask: Ask, high_risk: bool) -> Verdict {
    if ask == Ask::Read {
        return Verdict::Allow;
    }
    if policy == Policy::Read {
        return Verdict::Deny;
    }
    if high_risk {
        return Verdict::Ask;
    }
    match (policy, ask) {
        (Policy::Full, _) => Verdict::Allow,
        (Policy::Edits, Ask::Edit) => Verdict::Allow,
        _ => Verdict::Ask,
    }
}

/// A política que um agente (pela CLI ou pelo MCP) pode pôr num integrante. Só a pessoa AUMENTA a
/// permissão de alguém: o orquestrador liga no máximo supervisionado e depois só restringe. Pura.
pub fn agent_may_set(current: Option<Policy>, wanted: Policy) -> Result<(), String> {
    let ceiling = current.unwrap_or(Policy::Ask);
    if wanted > ceiling {
        return Err(format!(
            "Só a pessoa aumenta a permissão de um integrante (no painel Time). Pelo ags dá para pôr no máximo '{}'.",
            ceiling.as_str()
        ));
    }
    Ok(())
}

/// Os papéis que o painel oferece, na ordem da prancheta, com o id do catálogo (`crate::roles`).
/// "UI" é o frontend; "Testes", o QA.
pub const TEAM_ROLES: &[&str] = &["frontend", "backend", "qa", "reviewer", "researcher", "devops", "generalist"];

/// O id do papel a partir do que se escreveu: os apelidos do time ("ui", "testes", "revisor") e
/// depois o catálogo e os papéis da pessoa (`canvas::roles`). `None` = não existe. Pura.
pub fn role_id(roles: &[crate::canvas::roles::Role], wanted: &str) -> Option<String> {
    let key = crate::canvas::roles::slug(wanted);
    let alias = match key.as_str() {
        "ui" | "front" | "front-end" | "interface" => Some("frontend"),
        "testes" | "tests" | "test" | "qa-tests" => Some("qa"),
        "revisor" | "review" | "revisao" => Some("reviewer"),
        "pesquisa" | "pesquisador" => Some("researcher"),
        "generalista" | "geral" => Some("generalist"),
        _ => None,
    };
    if let Some(id) = alias {
        return Some(id.to_string());
    }
    crate::canvas::roles::resolve(roles, wanted).ok().map(|r| r.id.clone())
}

/// A política padrão de um papel: quem só olha (revisor, pesquisador) nasce só leitura. Pura.
pub fn default_policy(role: &str) -> Policy {
    match role {
        "reviewer" | "researcher" => Policy::Read,
        _ => Policy::Ask,
    }
}

/// A branch do worktree de um integrante: `team/<papel>` ("UI" vira `team/ui`, "Testes" `team/tests`).
/// Pura.
pub fn branch_for(role: &str) -> String {
    let slug = crate::canvas::roles::slug(role);
    let name = match slug.as_str() {
        "frontend" => "ui",
        "qa" => "tests",
        "" => "membro",
        other => other,
    };
    format!("team/{name}")
}

/// Aparado, numa linha e cortado. Pura.
pub fn clean(raw: &str, max: usize) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max - 1).collect();
    out.push('…');
    out
}

pub fn clean_label(raw: &str) -> String {
    clean(raw, MAX_LABEL)
}

pub fn clean_title(raw: &str) -> String {
    clean(raw, MAX_TITLE)
}

/// A frase do rodapé e do resumo: "4 agentes · 1 orquestrador" conta o orquestrador. Pura.
pub fn headcount(members: usize) -> usize {
    members + 1
}

/// Um integrante como aparece nos textos para os agentes.
#[derive(Clone, Debug, PartialEq)]
pub struct Named<'a> {
    pub name: &'a str,
    pub agent: &'a str,
    pub role: &'a str,
    pub policy: Policy,
    pub branch: Option<&'a str>,
    /// Marcado como subagente (o interruptor do canvas): só executa o que o orquestrador envia.
    pub subagent: bool,
}

/// O que o integrante recebe ao entrar no time: quem é o orquestrador, o papel, a política e a regra
/// de esperar a tarefa. `instructions` são as do papel no catálogo (vazio = sem). Pura.
pub fn member_briefing(orchestrator: &str, me: &Named<'_>, instructions: &str) -> String {
    let mut out = format!(
        "[ADE AGS] Você entrou no time de {orchestrator} como {} (política: {}).",
        me.role,
        policy_phrase(me.policy)
    );
    if let Some(branch) = me.branch.filter(|b| !b.is_empty()) {
        out.push_str(&format!(" Trabalhe só na sua branch ({branch}), sem push e sem PR."));
    }
    if !instructions.trim().is_empty() {
        out.push_str(&format!(" Seu papel: {}", instructions.trim()));
    }
    if me.subagent {
        // A mesma frase do canvas (`agentRole.ts::roleBriefing`).
        out.push_str(" Você é um subagente: execute as tarefas que o orquestrador enviar e responda com `ags peer tell`.");
    }
    out.push_str(&format!(
        " Não explore nem edite antes de receber a tarefa de {orchestrator}. Responda e avise com `ags peer tell \"{orchestrator}\" \"...\"`; \
         a entrega final vai UMA vez com `ags peer deliver --file entrega.json` (Handoff v1)."
    ));
    out
}

/// O resumo do time para o orquestrador (vai na próxima mensagem do modo Time). Pura.
pub fn roster_notice(members: &[Named<'_>]) -> String {
    if members.is_empty() {
        return "[ADE AGS] Você é o orquestrador deste time, mas ainda não há ninguém ligado. Peça à pessoa para ligar agentes no painel Time.".into();
    }
    let list = members
        .iter()
        .map(|m| {
            let branch = m.branch.filter(|b| !b.is_empty()).map(|b| format!(", {b}")).unwrap_or_default();
            let subagent = if m.subagent { "; subagente" } else { "" };
            format!("{} ({}; {}; {}{subagent}{branch})", m.name, m.agent, m.role, policy_phrase(m.policy))
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "[ADE AGS] Você é o orquestrador deste time: {list}. Delegue em ~2 min com `ags peer tell <nome> --task \"...\" --expecting \"...\"` \
         e encerre o turno; as entregas voltam como mensagem. Use `ags team list` para ver o time."
    )
}

fn policy_phrase(policy: Policy) -> &'static str {
    match policy {
        Policy::Full => "acesso total",
        Policy::Edits => "aceita edições",
        Policy::Ask => "supervisionado",
        Policy::Read => "só leitura",
    }
}
