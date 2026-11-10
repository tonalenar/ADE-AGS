//! O Parar do Codex que chega antes de o turno abrir (puro, sem processo).
//!
//! O app-server só aceita `turn/interrupt` depois do `turn/started`; antes disso recusa com `-32600`
//! ("no active turn to interrupt"). Entre o `turn/start` sair e o `turn/started` chegar há uma janela em
//! que a pessoa já vê o turno rodando. Nela, o Parar não pode ser mandado nem perdido: fica **pendente** e
//! sai quando o aviso chega. Se o turno terminar (ou o `turn/start` falhar) antes, a pendência morre junto.
//!
//! A pendência é amarrada ao id do turno quando ele é conhecido, para um Parar velho nunca cair no turno
//! seguinte. Antes da resposta do `turn/start` o id ainda não existe ([`Wanted::Any`]); a resposta o fixa.

/// O turno que o Parar pendente quer parar.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Wanted {
    /// O `turn/start` ainda não respondeu: o turno que abrir.
    Any,
    /// Um turno já conhecido pelo id.
    Turn(String),
}

/// O que fazer com um Parar recebido.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StopAction {
    /// O turno já abriu: manda o `turn/interrupt` agora.
    Send(String),
    /// O turno ainda não abriu: o Parar ficou pendente e sai no `turn/started`.
    Deferred,
    /// Nenhum turno aberto nem a caminho: não há o que parar.
    NoTurn,
}

#[derive(Default)]
pub struct StopGate {
    /// Há um `turn/start` enviado e sem resposta.
    starting: bool,
    /// O turno cujo `turn/started` já chegou.
    started: Option<String>,
    wanted: Option<Wanted>,
}

impl StopGate {
    /// O `turn/start` vai sair: um turno novo começa, sem herdar nada do anterior.
    pub fn begin_start(&mut self) {
        self.starting = true;
        self.started = None;
        self.wanted = None;
    }

    /// A resposta do `turn/start` (`Some(id)`) ou a falha dele / o turno que já acabou (`None`).
    pub fn end_start(&mut self, turn: Option<&str>) {
        self.starting = false;
        match (turn, self.wanted.take()) {
            (Some(id), Some(Wanted::Any)) => self.wanted = Some(Wanted::Turn(id.to_string())),
            (_, wanted @ Some(Wanted::Turn(_))) if turn.is_some() => self.wanted = wanted,
            _ => {}
        }
    }

    /// O `turn/started` chegou. `true` = há Parar pendente para esse turno: mande o `turn/interrupt`.
    pub fn on_started(&mut self, id: &str) -> bool {
        self.started = Some(id.to_string());
        match self.wanted.take() {
            Some(Wanted::Any) => true,
            Some(Wanted::Turn(t)) if t == id => true,
            other => {
                self.wanted = other;
                false
            }
        }
    }

    /// O `turn/completed` chegou: o Parar pendente desse turno (ou ainda sem turno) perde o sentido.
    pub fn on_completed(&mut self, id: &str) {
        if self.started.as_deref() == Some(id) {
            self.started = None;
        }
        if matches!(&self.wanted, Some(Wanted::Turn(t)) if t == id) || (self.wanted == Some(Wanted::Any) && !self.starting) {
            self.wanted = None;
        }
    }

    /// O processo caiu ou a conversa fechou: nada mais fica pendente.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Um Parar da pessoa. `turn` é o turno em andamento da sessão, se houver.
    pub fn request_stop(&mut self, turn: Option<&str>) -> StopAction {
        match turn {
            Some(id) if self.started.as_deref() == Some(id) => StopAction::Send(id.to_string()),
            Some(id) => {
                self.wanted = Some(Wanted::Turn(id.to_string()));
                StopAction::Deferred
            }
            None if self.starting => {
                self.wanted = Some(Wanted::Any);
                StopAction::Deferred
            }
            None => StopAction::NoTurn,
        }
    }
}
