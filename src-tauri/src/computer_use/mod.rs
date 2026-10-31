//! Laço comum de computer use. Drivers são responsáveis pelo escopo do canvas, permissões
//! nativas, captura e execução; o núcleo nunca recebe valores de campos nem gera texto.
//! Uma decisão não é prova de sucesso. Confirmação é por ação e expira ao mudar a observação.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

mod jev;
pub use jev::JevDecider;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Click,
    Type,
    Scroll,
    Key,
    Wait,
    Done,
    Stuck,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Ordinary,
    Sensitive,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub id: String,
    /// Nome acessível sem valor do campo. Nunca inclua AXValue/valor de formulário.
    pub label: String,
    pub operations: Vec<Operation>,
    pub risk: Risk,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    /// Identidade da superfície + revisão semântica da tela, não apenas o número do quadro.
    pub revision: String,
    pub text: String,
    pub targets: Vec<Target>,
    /// O driver só marca true após remover valores de campos e conferir conteúdo sensível.
    pub safe_for_provider: bool,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub goal: String,
    /// Os valores ficam somente aqui e na chamada local ao driver.
    pub fills: BTreeMap<String, String>,
    pub expect: Vec<String>,
    pub steps: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Action {
    pub operation: Operation,
    pub target: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Decision {
    /// O decisor só pode elevar o risco, nunca dispensar a classificação local.
    pub requires_confirmation: bool,
    pub action: Action,
    pub probability: f64,
    pub goal_done: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Done,
    Unverified,
    Blocked,
    Unsure,
    Stuck,
    Limit,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub status: Status,
    /// Somente ações, sem valores digitados, foto, árvore ou resposta crua do provedor.
    pub actions: Vec<Action>,
    pub reason: String,
    pub observations: usize,
    pub queries: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    AccessibilityPermission,
    ScreenRecordingPermission,
    OutsideScope,
    Operation,
    Timeout,
}

impl From<String> for Failure {
    fn from(_: String) -> Self {
        Self::Operation
    }
}

impl Failure {
    fn message(&self) -> &'static str {
        match self {
            Self::Timeout => "Prazo do computer use esgotado; observe a tela antes de continuar.",
            Self::AccessibilityPermission => {
                "Autorize a ADE em Ajustes do Sistema → Privacidade e Segurança → Acessibilidade para continuar."
            }
            Self::ScreenRecordingPermission => {
                "Autorize a ADE em Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela para continuar."
            }
            Self::OutsideScope => {
                "A superfície não está mais autorizada para este agente. Reconecte o nó pelo canvas."
            }
            Self::Operation => {
                "A superfície ou o provedor falhou. Não repeti a ação; observe a tela antes de continuar."
            }
        }
    }
}

pub trait Surface {
    /// Checa escopo e permissões antes de ler qualquer dado. Falha não tem fallback de privilégio.
    fn authorize(&mut self) -> Result<(), Failure>;
    fn observe(&mut self) -> Result<Observation, String>;
    /// Deve comparar a revisão na execução, antes do primeiro efeito; false = stale, sem efeito.
    /// Mesmo erro de transporte não autoriza repetir uma mutação.
    fn execute(
        &mut self,
        revision: &str,
        action: &Action,
        value: Option<&str>,
    ) -> Result<bool, String>;
    /// Confirmação da pessoa na UI (nunca flag da CLI ou decisão do modelo).
    /// O driver deve garantir que a tela/revisão ainda confere depois do diálogo.
    fn confirm(&mut self, revision: &str, action: &Action) -> Result<bool, String>;
}

pub trait Decider {
    /// Recebe só objetivo, observação sanitizada e ações, sem Request/fills.
    fn decide(
        &mut self,
        goal: &str,
        observation: &Observation,
        actions: &[Action],
    ) -> Result<Decision, String>;
}

fn secret(text: &str) -> bool {
    crate::decisions::computer_secret(text)
}

fn sensitive_label(label: &str) -> bool {
    let label = label.to_lowercase();
    [
        "enviar",
        "send",
        "submit",
        "comprar",
        "buy",
        "pay",
        "pagar",
        "checkout",
        "delete",
        "apagar",
        "excluir",
        "remove",
        "senha",
        "password",
        "sair",
        "logout",
        "log out",
        "sign out",
        "purchase",
        "confirmar",
        "confirm",
        "enviar",
        "borrar",
        "contraseña",
        "cerrar sesión",
    ]
    .iter()
    .any(|term| label.contains(term))
}

fn valid(observation: &Observation) -> bool {
    let mut ids = BTreeSet::new();
    !observation.revision.is_empty()
        && observation.targets.len() <= 100
        && observation.targets.iter().all(|t| {
            !t.id.is_empty()
                && t.id.len() <= 16
                && t.id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                && ids.insert(&t.id)
                && !secret(&t.label)
        })
}

fn verified(request: &Request, observation: &Observation) -> bool {
    !request.expect.is_empty()
        && request
            .expect
            .iter()
            .all(|text| observation.text.contains(text))
}

/// Mesmo orçamento do piloto do navegador. Sem retries de mutação nem esperas de relógio:
/// cada driver observa o estado após a ação e implementa a própria espera baseada em eventos.
pub fn run(request: &Request, surface: &mut impl Surface, decider: &mut impl Decider) -> Report {
    let mut report = Report {
        status: Status::Blocked,
        actions: vec![],
        reason: String::new(),
        observations: 0,
        queries: 0,
    };
    let result = run_inner(request, surface, decider, &mut report);
    match result {
        Ok((status, reason)) => {
            report.status = status;
            report.reason = reason.into();
        }
        // Erros de drivers/provedor podem conter o valor digitado ou a árvore. Não os ecoar.
        Err(failure) => report.reason = failure.message().into(),
    }
    report
}

fn run_inner(
    request: &Request,
    surface: &mut impl Surface,
    decider: &mut impl Decider,
    report: &mut Report,
) -> Result<(Status, &'static str), Failure> {
    if request.goal.trim().is_empty()
        || request.goal.len() > 8000
        || secret(&request.goal)
        || !(1..=15).contains(&request.steps)
        || request.expect.iter().any(|e| e.trim().is_empty())
    {
        return Ok((
            Status::Blocked,
            "Objetivo, expectativa ou orçamento inválido; nada foi observado.",
        ));
    }
    let mut local_values: Vec<&str> = request
        .fills
        .values()
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .collect();
    local_values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    let mut provider_goal = request.goal.clone();
    for value in &local_values {
        provider_goal = provider_goal.replace(*value, "[valor local]");
    }
    surface.authorize()?;
    let mut previous = Vec::new();
    // Há sempre uma leitura final, mesmo quando a última ação esgota o orçamento.
    for turn in 0..=request.steps {
        surface.authorize()?;
        let observation = surface.observe()?;
        report.observations += 1;
        // A observação pode esperar captura/OCR ou uma confirmação de privacidade.
        surface.authorize()?;
        if !valid(&observation) {
            return Ok((
                Status::Blocked,
                "Observação inválida ou sensível; não consultei o provedor.",
            ));
        }
        if verified(request, &observation) {
            return Ok((
                Status::Done,
                "FEITO (verificado pelas expectativas na observação atual).",
            ));
        }
        if turn == request.steps {
            return Ok((
                Status::Limit,
                "Orçamento esgotado; resultado final observado.",
            ));
        }
        if !observation.safe_for_provider
            || secret(&observation.text)
            || local_values.iter().any(|value| {
                observation.text.contains(*value)
                    || observation.targets.iter().any(|t| t.label.contains(*value))
            })
        {
            return Ok((
                Status::Blocked,
                "Privacidade não verificada pelo driver; observação não enviada ao provedor.",
            ));
        }
        report.queries += 1;
        let decision = decider.decide(&provider_goal, &observation, &report.actions)?;
        if !decision.probability.is_finite() || !(0.4..=1.0).contains(&decision.probability) {
            return Ok((Status::Unsure, "Sem probabilidade suficiente para agir."));
        }
        let action = decision.action;
        match action.operation {
            Operation::Done => {
                let confident = decision
                    .goal_done
                    .is_some_and(|p| p.is_finite() && (0.75..=1.0).contains(&p));
                return Ok(if confident && request.expect.is_empty() {
                    (
                        Status::Unverified,
                        "FEITO (não verificado): o Jev concluiu, sem prova independente.",
                    )
                } else {
                    (
                        Status::Unsure,
                        "A conclusão do Jev não confere com as expectativas ou não tem probabilidade suficiente.",
                    )
                });
            }
            Operation::Stuck => {
                return Ok((Status::Stuck, "O piloto não encontrou como continuar."));
            }
            _ => {}
        }
        let target = action
            .target
            .as_ref()
            .and_then(|id| observation.targets.iter().find(|t| &t.id == id));
        // Todas as mutações têm um alvo explícito da observação; teclas soltas não podem enviar formulários.
        if action.operation != Operation::Wait
            && !target.is_some_and(|t| t.operations.contains(&action.operation))
        {
            return Ok((
                Status::Blocked,
                "Alvo ou operação não oferecido pela observação atual.",
            ));
        }
        let signature = (observation.revision.clone(), action.clone());
        if previous.contains(&signature) {
            return Ok((
                Status::Stuck,
                "A mesma ação na mesma tela não será repetida.",
            ));
        }
        let value = if action.operation == Operation::Type {
            let Some(value) = action.target.as_ref().and_then(|id| request.fills.get(id)) else {
                return Ok((
                    Status::Blocked,
                    "Texto só pode vir de --fill para o alvo escolhido.",
                ));
            };
            Some(value.as_str())
        } else {
            None
        };
        let sensitive = decision.requires_confirmation
            || target.is_some_and(|t| {
                t.risk != Risk::Ordinary || t.label.trim().is_empty() || sensitive_label(&t.label)
            })
            || action.operation == Operation::Key;
        if sensitive && !surface.confirm(&observation.revision, &action)? {
            return Ok((Status::Blocked, "A pessoa não confirmou a ação na UI."));
        }
        // Checa a autorização de novo: o canvas pode mudar enquanto o diálogo está aberto.
        surface.authorize()?;
        // Registra ANTES da chamada, pois um erro pode acontecer depois de o SO aplicar o efeito.
        report.actions.push(action.clone());
        if !surface.execute(&observation.revision, &action, value)? {
            report.actions.pop();
        }
        previous.push(signature);
    }
    unreachable!()
}

#[cfg(test)]
mod test;

pub(crate) mod ios;
