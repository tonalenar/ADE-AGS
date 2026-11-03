//! O que uma conversa ou aba alcança: **uma função só** (`reach`).
//!
//! Antes, a listagem (`devices::reachable`) e a autorização (`computer_use/ios.rs`, `portals.rs`) olhavam
//! por caminhos diferentes, e o `sim act` bloqueava um aparelho que o `device list` mostrava. Agora quem
//! lista e quem autoriza chamam `reach`, e a autorização é refeita a cada passo da ação.
//!
//! Duas origens:
//! - **Canvas**: o portal ligado por corda ao ator (ou, se ele é orquestrador, aos do time). Controle total.
//! - **ChatPanel**: um aparelho aberto no painel direito do modo chat (id `chat:<udid|serial>`). Sem corda;
//!   só deixa olhar (`shot`/`tree`) enquanto a chave "Permitir que agentes controlem dispositivos" estiver
//!   desligada. Mutação (e o `sim act`) exige a chave.
//!
//! O ator é um id de aba (terminal) ou `thread:<id>` (conversa por protocolo): as duas entram igual aqui.
//! A prova de **quem** é o ator fica em `terminal::authorize_actor`; este módulo só decide **o que** ele alcança.
//! O `desk act` (Mac inteiro) não passa por aqui: depende só do ator e da aprovação na UI.

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::canvas::{self, Boards, Portal};

#[cfg(test)]
mod test;

/// O prefixo do id de um aparelho do painel do chat (não há nó do canvas com ele).
pub(crate) const CHAT_PREFIX: &str = "chat:";

/// De onde vem o alcance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Canvas,
    ChatPanel,
}

/// Uma superfície que o ator alcança.
#[derive(Debug, Clone)]
pub(crate) struct Reach {
    /// Chave do canvas (`janela|pasta`); `None` para aparelho do painel do chat.
    pub board: Option<String>,
    pub id: String,
    pub portal: Portal,
    pub source: Source,
    /// Pode mutar (tocar, digitar, abrir app)? Canvas: sempre. Painel do chat: só com a chave da pessoa.
    pub control: bool,
}

impl Reach {
    pub(crate) fn kind(&self) -> Option<&str> {
        self.portal.kind.as_deref()
    }

    /// `shot` e `tree` só olham; o resto muda o aparelho.
    pub(crate) fn allows(&self, action: &str) -> Result<(), String> {
        if self.control || matches!(action, "shot" | "tree") {
            return Ok(());
        }
        Err(format!(
            "A pessoa não liberou o controle deste aparelho no painel do chat (a chave \"Permitir que agentes controlem dispositivos\" está desligada): `{action}` não é permitido. Você pode olhar com `ags device shot` e `ags device tree`."
        ))
    }
}

// ── Aparelhos compartilhados pelo painel do modo chat ──

/// Um aparelho aberto no painel direito do modo chat, como o frontend manda.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedDevice {
    /// `ios` ou `android`.
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub udid: Option<String>,
    #[serde(default)]
    pub serial: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct ChatShare {
    pub devices: Vec<SharedDevice>,
    pub control: bool,
}

/// Só em memória: o painel manda de novo a cada mudança, e com o app fechado não há o que compartilhar.
fn chat_share() -> &'static Mutex<ChatShare> {
    static S: OnceLock<Mutex<ChatShare>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Confere a lista do painel: tipo conhecido, nome, e o UDID (iOS) ou o serial (Android).
pub(crate) fn check_shared(devices: &[SharedDevice]) -> Result<(), String> {
    for d in devices {
        let key = match d.kind.as_str() {
            "ios" => d.udid.as_deref(),
            "android" => d.serial.as_deref(),
            other => return Err(format!("Tipo de aparelho desconhecido: \"{other}\" (ios ou android).")),
        };
        if key.is_none_or(|k| k.trim().is_empty()) {
            return Err(format!("O aparelho \"{}\" veio sem {}.", d.name, if d.kind == "ios" { "udid" } else { "serial" }));
        }
    }
    Ok(())
}

/// Substitui o que o painel do chat compartilha.
pub(crate) fn share(devices: Vec<SharedDevice>, control: bool) -> Result<(), String> {
    check_shared(&devices)?;
    let mut slot = chat_share().lock().map_err(|_| "O compartilhamento de aparelhos travou.".to_string())?;
    *slot = ChatShare { devices, control };
    Ok(())
}

// ── O alcance ──

/// Os portais do canvas que `actor` maneja (corda direta; orquestrador também os do time) e os aparelhos do
/// painel do chat. Um aparelho do painel que já é portal do canvas ligado ao ator fica de fora: pelo canvas
/// ele já o controla, e o mesmo aparelho duas vezes só confundiria a resolução.
pub(crate) fn compute(boards: &Boards, chat: &ChatShare, actor: &str) -> Vec<Reach> {
    let mut list: Vec<Reach> = canvas::portals_for(boards, actor)
        .into_iter()
        .filter_map(|(key, id)| {
            let portal = boards.get(&key)?.portals.get(&id)?.clone();
            Some(Reach { board: Some(key), id, portal, source: Source::Canvas, control: true })
        })
        .collect();
    let extra: Vec<Reach> = chat
        .devices
        .iter()
        .filter_map(|d| {
            let key = if d.kind == "ios" { d.udid.clone()? } else { d.serial.clone()? };
            let on_canvas = list.iter().any(|c| {
                c.kind() == Some(d.kind.as_str())
                    && (if d.kind == "ios" { c.portal.udid.as_deref() } else { c.portal.serial.as_deref() }) == Some(key.as_str())
            });
            (!on_canvas).then(|| Reach {
                board: None,
                id: format!("{CHAT_PREFIX}{key}"),
                portal: Portal {
                    name: d.name.clone(),
                    kind: Some(d.kind.clone()),
                    udid: d.udid.clone().filter(|_| d.kind == "ios"),
                    serial: d.serial.clone().filter(|_| d.kind == "android"),
                    ..Default::default()
                },
                source: Source::ChatPanel,
                control: chat.control,
            })
        })
        .collect();
    list.extend(extra);
    list
}

/// O alcance de `actor` agora (lê o canvas e o painel). É a **única** porta de entrada.
pub(crate) fn reach(actor: &str) -> Vec<Reach> {
    let chat = chat_share().lock().map(|s| s.clone()).unwrap_or_default();
    compute(&canvas::load_boards(), &chat, actor)
}

/// Só os aparelhos (Android e iOS), de qualquer origem.
pub(crate) fn devices(actor: &str) -> Vec<Reach> {
    reach(actor).into_iter().filter(|r| matches!(r.kind(), Some("android") | Some("ios"))).collect()
}

/// Só os portais do canvas (navegadores e nós de aparelho), sem os do painel do chat.
pub(crate) fn canvas_portals(boards: &Boards, actor: &str) -> Vec<Reach> {
    compute(boards, &ChatShare::default(), actor)
}

/// O nó iOS `node` (com este `udid`) ainda é do ator e ele pode `action` nele? Refeito a cada passo do
/// computer use: a corda ou a chave podem ter mudado desde o passo anterior.
pub(crate) fn ios_allows(actor: &str, node: &str, udid: &str, action: &str) -> bool {
    allows_in(&devices(actor), node, udid, action)
}

pub(crate) fn allows_in(list: &[Reach], node: &str, udid: &str, action: &str) -> bool {
    list.iter().any(|r| r.id == node && r.kind() == Some("ios") && r.portal.udid.as_deref() == Some(udid) && r.allows(action).is_ok())
}
