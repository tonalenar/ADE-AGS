//! Bancada dos motores por protocolo (só nos testes): um agente falso que toca um roteiro e um "motor de bancada"
//! que lê o que ele escreveu pelos MESMOS mapeadores do app (`claude_map`, `codex_map`, `opencode_map`), por
//! `turn::dropped` e pelas mesmas regras de erro. Ver `docs/ade-ags/BANCADA_MOTORES.md`.
//!
//! - [`Roteiro`]: os passos (sessão, texto, ferramenta, aprovação, pergunta, silêncio, JSON quebrado, queda, cota,
//!   `max_tokens`, interrupção, fim), escritos à mão ou sorteados com uma semente ([`Roteiro::aleatorio`]);
//! - [`tocar`]: o roteiro vira as linhas que `claude -p` (stream-json), `codex app-server` ou o ACP escreveriam
//!   no stdout, com o tempo de cada uma num relógio falso;
//! - [`rodar`]: as linhas passam pelo que o laço de leitura de cada motor faz (`read_loop` + `dispatch`) e viram
//!   um [`Resultado`]: a sessão, a timeline, os pedidos, o fim do turno e as classes de erro;
//! - [`Espera`]: o que um roteiro (ou uma fixture de replay) promete; [`conferir`] diz o que não bateu.
//!
//! Sem processo, sem rede, sem cota e sem relógio de verdade: um silêncio de 61 s custa um número somado.
//! O que a bancada não reproduz: o processo de verdade (pipes, `kill`), a escrita no stdin e as filas de envio.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::canal::timeline::{Item, ItemKind, ToolKind};
use crate::runs::failure::{classify, FailureKind};

use super::agy_map::{self, Out as AgyOut};
use super::claude_map::{self, Out as ClaudeOut, TurnResult};
use super::codex_map;
use super::cursor_map::{self, Read as CursorRead};
use super::opencode_map::{self, Out as AcpOut};
use super::resume::{self, ResumeFailure};
use super::turn;

/// O "agora" do relógio falso no instante 0 (ms). Nunca 0, para um carimbo zerado não passar por certo.
pub const EPOCH_MS: i64 = 1_790_000_000_000;
/// O prazo dos pedidos de abertura (`initialize`, `thread/resume`, `session/new`), como nos motores (60 s).
pub const PRAZO_PEDIDO_MS: u64 = 60_000;
/// Cada linha escrita anda o relógio um pouco, para a ordem dos carimbos ser a da saída.
const PASSO_MS: u64 = 10;

/// Ids fixos dos pedidos que o app faz ao abrir (o fake responde a eles).
const CODEX_ABRIR: u64 = 1;
const ACP_INICIAR: u64 = 1;
const ACP_SESSAO: u64 = 2;
const ACP_PROMPT: u64 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum Protocolo {
    /// `claude -p --output-format stream-json`.
    #[serde(rename = "claude-stream")]
    ClaudeStream,
    /// `codex app-server` (JSON-RPC por linha).
    #[serde(rename = "codex-app-server")]
    CodexAppServer,
    /// Agent Client Protocol (`opencode acp`).
    #[serde(rename = "acp")]
    Acp,
    /// `agy --print --output-format stream-json`. Laço simples, sem prazo de silêncio.
    #[serde(rename = "agy-stream")]
    AgyStream,
    /// `cursor-agent -p --output-format stream-json`. O turno fecha no `result` ou quando o próximo
    /// `atMs` passa de `Mapper::quiet_after` (relógio falso, sem espera real).
    #[serde(rename = "cursor-stream")]
    CursorStream,
}

impl Protocolo {
    fn nome(self) -> &'static str {
        match self {
            Protocolo::ClaudeStream => "Claude",
            Protocolo::CodexAppServer => "Codex",
            Protocolo::Acp => "OpenCode",
            Protocolo::AgyStream => "Antigravity",
            Protocolo::CursorStream => "Cursor",
        }
    }

    /// O pedido que abre a sessão, como os motores escrevem no erro de prazo.
    fn pedido_de_abertura(self) -> &'static str {
        match self {
            Protocolo::ClaudeStream => "initialize",
            Protocolo::CodexAppServer => "thread/resume",
            Protocolo::Acp => "session/resume",
            Protocolo::AgyStream => "init",
            Protocolo::CursorStream => "system/init",
        }
    }
}

/// Um passo do roteiro. Em JSON: `{ "passo": "texto", "texto": "oi", "pedacos": 2 }`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "passo", rename_all = "camelCase", deny_unknown_fields)]
pub enum Passo {
    /// A sessão abriu (o `init` do Claude, a resposta do `thread/start|resume`, a do `session/new|resume`).
    Sessao { id: String },
    /// O agente recusou a abertura (sessão que não existe mais, outra conta): o erro do pedido.
    Recusa { mensagem: String },
    /// A fala do agente; com `pedacos` > 1 chega antes em pedaços (deltas) e fecha com o texto inteiro.
    Texto {
        texto: String,
        #[serde(default)]
        pedacos: usize,
    },
    /// Uma ferramenta que roda e devolve `saida` (com `erro`, falha).
    Ferramenta {
        nome: String,
        #[serde(default)]
        entrada: Value,
        #[serde(default)]
        saida: String,
        #[serde(default)]
        erro: bool,
    },
    /// O agente pede aprovação para rodar um comando.
    Aprovacao { comando: String },
    /// O agente pergunta (no ACP não existe: [`tocar`] recusa).
    Pergunta { pergunta: String, opcoes: Vec<String> },
    /// Nada sai por `ms` milissegundos (só o relógio anda).
    Stall { ms: u64 },
    /// Uma linha que não é JSON (cortada no meio).
    JsonMalformado,
    /// O processo fecha sozinho; `stderr` é o que ele deixou.
    Desconecta {
        #[serde(default)]
        stderr: Option<String>,
    },
    /// O turno falha pelo limite da conta (429, cota de 5 h).
    Cota { mensagem: String },
    /// O turno para no limite de tokens do modelo.
    MaxTokens,
    /// A pessoa parou o turno.
    Interrompido,
    /// O turno acaba bem.
    Fim,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Roteiro {
    pub protocolo: Protocolo,
    pub passos: Vec<Passo>,
}

/// O que o fake escreveu (ou fez) e quando, no relógio falso.
#[derive(Clone, Debug, PartialEq)]
pub struct Saida {
    pub at_ms: u64,
    pub evento: Evento,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Evento {
    /// Uma linha do stdout, como saiu (pode não ser JSON).
    Linha(String),
    /// O processo fechou; o rabo do stderr.
    Fecha { stderr: Option<String> },
}

/// Gerador pseudoaleatório pequeno (splitmix64): a mesma semente dá sempre o mesmo roteiro, em qualquer máquina.
pub struct Semente(u64);

impl Semente {
    pub fn new(seed: u64) -> Semente {
        Semente(seed)
    }

    pub fn proximo(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn ate(&mut self, n: u64) -> u64 {
        self.proximo() % n.max(1)
    }
}

impl Roteiro {
    pub fn new(protocolo: Protocolo, passos: Vec<Passo>) -> Roteiro {
        Roteiro { protocolo, passos }
    }

    /// Um roteiro sorteado: abre a sessão, faz de 1 a `max_passos` coisas no meio do turno e acaba de um dos jeitos
    /// (bem, cota, `max_tokens`, interrupção, queda, ou sem fim). Reproduza uma falha com a mesma `seed`.
    pub fn aleatorio(protocolo: Protocolo, seed: u64, max_passos: usize) -> Roteiro {
        let mut rng = Semente::new(seed);
        let mut passos = vec![Passo::Sessao { id: format!("sessao-{seed}") }];
        let n = 1 + rng.ate(max_passos.max(1) as u64) as usize;
        for i in 0..n {
            let escolhas = if protocolo == Protocolo::Acp { 6 } else { 7 };
            passos.push(match rng.ate(escolhas) {
                0 => Passo::Texto { texto: format!("fala {i} da semente {seed}"), pedacos: rng.ate(4) as usize },
                1 => Passo::Ferramenta {
                    nome: "Bash".into(),
                    entrada: json!({ "command": format!("echo {i}") }),
                    saida: format!("{i}"),
                    erro: rng.ate(3) == 0,
                },
                2 => Passo::Aprovacao { comando: format!("rm -rf alvo-{i}") },
                3 => Passo::Stall { ms: rng.ate(120_000) },
                4 => Passo::JsonMalformado,
                5 => Passo::Texto { texto: format!("resumo {i}"), pedacos: 0 },
                _ => Passo::Pergunta { pergunta: format!("Sigo com o passo {i}?"), opcoes: vec!["Sim".into(), "Não".into()] },
            });
        }
        match rng.ate(6) {
            0 => passos.push(Passo::Fim),
            1 => passos.push(Passo::Cota { mensagem: "You've hit your limit · resets 3pm (America/Sao_Paulo)".into() }),
            2 => passos.push(Passo::MaxTokens),
            3 => passos.push(Passo::Interrompido),
            4 => passos.push(Passo::Desconecta { stderr: Some("panic: conexão perdida".into()) }),
            _ => {}
        }
        Roteiro { protocolo, passos }
    }
}

/// O roteiro tocado: as linhas que o agente escreveria, na ordem, com o tempo de cada uma.
pub fn tocar(roteiro: &Roteiro) -> Result<Vec<Saida>, String> {
    let mut fake = Fake { protocolo: roteiro.protocolo, relogio: 0, saidas: Vec::new(), seq: 0, turno: None };
    for passo in &roteiro.passos {
        fake.passo(passo)?;
    }
    Ok(fake.saidas)
}

struct Fake {
    protocolo: Protocolo,
    relogio: u64,
    saidas: Vec<Saida>,
    seq: u64,
    /// O turno do Codex já começou (`turn/started`)? O id dele.
    turno: Option<String>,
}

impl Fake {
    fn linha(&mut self, value: Value) {
        self.cru(value.to_string());
    }

    fn cru(&mut self, line: String) {
        self.saidas.push(Saida { at_ms: self.relogio, evento: Evento::Linha(line) });
        self.relogio += PASSO_MS;
    }

    fn id(&mut self, prefixo: &str) -> String {
        self.seq += 1;
        format!("{prefixo}_{}", self.seq)
    }

    /// O Codex só manda os itens dentro de um turno: abre o turno antes do primeiro.
    fn turno_codex(&mut self) -> String {
        if let Some(id) = &self.turno {
            return id.clone();
        }
        let id = self.id("turn");
        self.linha(json!({ "method": "turn/started", "params": { "turn": { "id": id, "status": "inProgress" } } }));
        self.turno = Some(id.clone());
        id
    }

    fn fim_codex(&mut self, status: &str, erro: Option<&str>) {
        let id = self.turno_codex();
        let mut turn = json!({ "id": id, "status": status, "durationMs": self.relogio });
        if let Some(m) = erro {
            turn["error"] = json!({ "message": m });
        }
        self.linha(json!({ "method": "turn/completed", "params": { "turn": turn } }));
        self.turno = None;
    }

    fn acp_update(&mut self, update: Value) {
        self.linha(json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "s", "update": update } }));
    }

    fn passo(&mut self, passo: &Passo) -> Result<(), String> {
        use Protocolo::*;
        match (passo, self.protocolo) {
            (Passo::Stall { ms }, _) => self.relogio += ms,
            (Passo::JsonMalformado, _) => self.cru(r#"{"type":"assistant","message":{"content":[{"type":"te"#.to_string()),
            (Passo::Desconecta { stderr }, _) => {
                self.saidas.push(Saida { at_ms: self.relogio, evento: Evento::Fecha { stderr: stderr.clone() } });
            }

            (Passo::Sessao { id }, ClaudeStream) => self.linha(json!({ "type": "system", "subtype": "init", "session_id": id, "permissionMode": "default" })),
            (Passo::Sessao { id }, CodexAppServer) => self.linha(json!({ "id": CODEX_ABRIR, "result": { "thread": { "id": id } } })),
            (Passo::Sessao { id }, Acp) => {
                self.linha(json!({ "jsonrpc": "2.0", "id": ACP_INICIAR, "result": { "protocolVersion": 1 } }));
                self.linha(json!({ "jsonrpc": "2.0", "id": ACP_SESSAO, "result": { "sessionId": id } }));
            }

            // O Claude que não acha a sessão do `--resume` responde com um resultado de erro antes do `init`.
            (Passo::Recusa { mensagem }, ClaudeStream) => self.linha(json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "result": mensagem })),
            (Passo::Recusa { mensagem }, CodexAppServer) => self.linha(json!({ "id": CODEX_ABRIR, "error": { "code": -32600, "message": mensagem } })),
            (Passo::Recusa { mensagem }, Acp) => {
                self.linha(json!({ "jsonrpc": "2.0", "id": ACP_INICIAR, "result": { "protocolVersion": 1 } }));
                self.linha(json!({ "jsonrpc": "2.0", "id": ACP_SESSAO, "error": { "code": -32002, "message": mensagem } }));
            }

            (Passo::Texto { texto, pedacos }, ClaudeStream) => {
                let msg = self.id("msg");
                for pedaco in pedacos_de(texto, *pedacos) {
                    self.linha(json!({ "type": "stream_event", "api_message_id": msg, "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": pedaco } } }));
                }
                self.linha(json!({ "type": "assistant", "message": { "id": msg, "role": "assistant", "content": [{ "type": "text", "text": texto }] } }));
            }
            (Passo::Texto { texto, pedacos }, CodexAppServer) => {
                let turn = self.turno_codex();
                let item = self.id("msg");
                for pedaco in pedacos_de(texto, *pedacos) {
                    self.linha(json!({ "method": "item/agentMessage/delta", "params": { "turnId": turn, "itemId": item, "delta": pedaco } }));
                }
                self.linha(json!({ "method": "item/completed", "params": { "turnId": turn, "item": { "id": item, "type": "agentMessage", "text": texto } } }));
            }
            (Passo::Texto { texto, pedacos }, Acp) => {
                for pedaco in pedacos_de(texto, (*pedacos).max(1)) {
                    self.acp_update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": pedaco } }));
                }
            }

            (Passo::Ferramenta { nome, entrada, saida, erro }, ClaudeStream) => {
                let (msg, tool) = (self.id("msg"), self.id("toolu"));
                self.linha(json!({ "type": "assistant", "message": { "id": msg, "role": "assistant", "content": [{ "type": "tool_use", "id": tool, "name": nome, "input": entrada }] } }));
                self.linha(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": tool, "content": saida, "is_error": erro }] } }));
            }
            (Passo::Ferramenta { nome, entrada, saida, erro }, CodexAppServer) => {
                let turn = self.turno_codex();
                let item = self.id("call");
                let command = entrada.get("command").and_then(Value::as_str).unwrap_or(nome).to_string();
                self.linha(json!({ "method": "item/started", "params": { "turnId": turn, "item": { "id": item, "type": "commandExecution", "command": command, "status": "inProgress" } } }));
                let status = if *erro { "failed" } else { "completed" };
                self.linha(json!({ "method": "item/completed", "params": { "turnId": turn, "item": {
                    "id": item, "type": "commandExecution", "command": command, "status": status, "aggregatedOutput": saida, "exitCode": if *erro { 1 } else { 0 },
                } } }));
            }
            (Passo::Ferramenta { nome, entrada, saida, erro }, Acp) => {
                let call = self.id("call");
                self.acp_update(json!({ "sessionUpdate": "tool_call", "toolCallId": call, "title": nome, "kind": "execute", "status": "in_progress", "rawInput": entrada }));
                self.acp_update(json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": call, "status": if *erro { "failed" } else { "completed" },
                    "rawInput": entrada, "content": [{ "type": "content", "content": { "type": "text", "text": saida } }],
                }));
            }

            (Passo::Aprovacao { comando }, ClaudeStream) => {
                let (req, tool) = (self.id("req"), self.id("toolu"));
                self.linha(json!({ "type": "control_request", "request_id": req, "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": comando }, "tool_use_id": tool } }));
            }
            (Passo::Aprovacao { comando }, CodexAppServer) => {
                let turn = self.turno_codex();
                let item = self.id("call");
                let rpc = 100 + self.seq;
                self.linha(json!({ "id": rpc, "method": "item/commandExecution/requestApproval", "params": { "turnId": turn, "itemId": item, "command": comando, "reason": "fora da pasta" } }));
            }
            (Passo::Aprovacao { comando }, Acp) => {
                let call = self.id("call");
                let rpc = 100 + self.seq;
                self.linha(json!({ "jsonrpc": "2.0", "id": rpc, "method": "session/request_permission", "params": {
                    "sessionId": "s",
                    "toolCall": { "toolCallId": call, "title": comando, "kind": "execute", "rawInput": { "command": comando } },
                    "options": [
                        { "optionId": "once", "kind": "allow_once", "name": "Permitir" },
                        { "optionId": "no", "kind": "reject_once", "name": "Negar" },
                    ],
                } }));
            }

            (Passo::Pergunta { pergunta, opcoes }, ClaudeStream) => {
                let (req, tool) = (self.id("req"), self.id("toolu"));
                let options: Vec<Value> = opcoes.iter().map(|o| json!({ "label": o })).collect();
                self.linha(json!({ "type": "control_request", "request_id": req, "request": {
                    "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": tool,
                    "input": { "questions": [{ "question": pergunta, "options": options }] },
                } }));
            }
            (Passo::Pergunta { pergunta, opcoes }, CodexAppServer) => {
                let turn = self.turno_codex();
                let item = self.id("ask");
                let rpc = 100 + self.seq;
                let options: Vec<Value> = opcoes.iter().map(|o| json!({ "label": o })).collect();
                self.linha(json!({ "id": rpc, "method": "item/tool/requestUserInput", "params": { "turnId": turn, "itemId": item, "questions": [{ "id": "q1", "question": pergunta, "options": options }] } }));
            }
            (Passo::Pergunta { .. }, Acp) => return Err("o ACP não tem pergunta ao usuário; use outro passo".into()),

            (Passo::Cota { mensagem }, ClaudeStream) => self.linha(json!({ "type": "result", "subtype": "success", "is_error": true, "result": mensagem, "duration_ms": self.relogio })),
            (Passo::Cota { mensagem }, CodexAppServer) => {
                self.linha(json!({ "method": "error", "params": { "error": { "message": mensagem }, "willRetry": false } }));
                self.fim_codex("failed", Some(mensagem));
            }
            (Passo::Cota { mensagem }, Acp) => self.linha(json!({ "jsonrpc": "2.0", "id": ACP_PROMPT, "error": { "code": 429, "message": mensagem } })),

            // Sintetizado: o Claude fecha a mensagem com `stop_reason: max_tokens` e o resultado sai sem erro.
            (Passo::MaxTokens, ClaudeStream) => {
                let msg = self.id("msg");
                self.linha(json!({ "type": "assistant", "message": { "id": msg, "role": "assistant", "stop_reason": "max_tokens", "content": [{ "type": "text", "text": "…e o texto para no meio" }] } }));
                self.linha(json!({ "type": "result", "subtype": "success", "is_error": false, "result": "", "duration_ms": self.relogio }));
            }
            // Sintetizado: o Codex dá o turno por falho com a mensagem do limite de saída.
            (Passo::MaxTokens, CodexAppServer) => self.fim_codex("failed", Some("The model reached max_output_tokens")),
            (Passo::MaxTokens, Acp) => self.linha(json!({ "jsonrpc": "2.0", "id": ACP_PROMPT, "result": { "stopReason": "max_tokens" } })),

            (Passo::Interrompido, ClaudeStream) => self.linha(json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "terminal_reason": "aborted_by_user", "duration_ms": self.relogio })),
            (Passo::Interrompido, CodexAppServer) => self.fim_codex("interrupted", None),
            (Passo::Interrompido, Acp) => self.linha(json!({ "jsonrpc": "2.0", "id": ACP_PROMPT, "result": { "stopReason": "cancelled" } })),

            (Passo::Fim, ClaudeStream) => self.linha(json!({ "type": "result", "subtype": "success", "is_error": false, "result": "pronto", "duration_ms": self.relogio })),
            (Passo::Fim, CodexAppServer) => self.fim_codex("completed", None),
            (Passo::Fim, Acp) => self.linha(json!({ "jsonrpc": "2.0", "id": ACP_PROMPT, "result": { "stopReason": "end_turn", "usage": { "totalTokens": 42 } } })),
            // O replay lê um transcript. Sintetizar o fluxo aqui afirmaria um formato que a captura real ainda não confirmou.
            (_, AgyStream | CursorStream) => return Err("o roteiro sintetizado não cobre Antigravity nem Cursor: use um transcript no replay".into()),
        }
        Ok(())
    }
}

/// O texto em `n` pedaços (0 ou 1 = nenhum delta no Claude e no Codex; o ACP sempre manda ao menos um).
fn pedacos_de(texto: &str, n: usize) -> Vec<String> {
    if n <= 1 {
        return if n == 1 { vec![texto.to_string()] } else { Vec::new() };
    }
    let chars: Vec<char> = texto.chars().collect();
    let tamanho = chars.len().div_ceil(n).max(1);
    chars.chunks(tamanho).map(|c| c.iter().collect()).collect()
}

/// Um pedido do agente à pessoa (aprovação ou pergunta), como o chat mostraria.
#[derive(Clone, Debug, PartialEq)]
pub struct Pedido {
    /// O id do protocolo (`request_id` do Claude, o `id` JSON-RPC do Codex e do ACP). Não entra no snapshot.
    pub id: String,
    pub kind: String,
    pub title: String,
    /// Ainda sem resposta nem cancelamento quando a leitura parou. O `in` do transcript (a resposta da pessoa)
    /// não é lido: o pedido só sai da lista se o próprio agente desistir (`control_cancel_request`,
    /// `serverRequest/resolved`).
    pub pendente: bool,
}

/// Evento de filho que o motor via e a timeline da conversa não guarda: a tarefa (`task`) ou o que o
/// subagente fez dentro dela (`subitem`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filho {
    /// `task` ou `subitem`.
    pub tipo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<Item>,
}

/// O que o motor de bancada viu.
#[derive(Debug, Default)]
pub struct Resultado {
    /// Como a abertura acabou: o id da sessão ou o texto do erro (o mesmo que o motor devolveria).
    pub abertura: Option<Result<String, String>>,
    /// O agente recusou a abertura com uma resposta de erro (no Codex isso é `Gone`, ver `codex::resume_failure`).
    pub recusada: bool,
    /// A timeline, como o banco guardaria (o item atualizado fica no lugar).
    pub itens: Vec<Item>,
    /// Os pedaços de texto que iriam só para a janela: `(item, pedaço)`.
    pub deltas: Vec<(String, String)>,
    pub pedidos: Vec<Pedido>,
    /// Tarefas e itens de subagente, na ordem em que chegaram. A timeline (`itens`) não os inclui.
    pub filhos: Vec<Filho>,
    /// O fim do turno, se houve.
    pub fim: Option<TurnResult>,
    /// O turno acabou porque o processo caiu.
    pub caiu: bool,
    /// Os erros avisados à parte (o `error` do Codex).
    pub avisos: Vec<String>,
    /// Linhas que não eram JSON (o motor pula).
    pub ignoradas: usize,
    /// O maior silêncio entre duas saídas (ms).
    pub silencio_max_ms: u64,
    /// Onde o relógio parou (ms).
    pub relogio_ms: u64,
}

impl Resultado {
    pub fn sessao(&self) -> Option<&str> {
        self.abertura.as_ref()?.as_ref().ok().map(String::as_str)
    }

    pub fn erro(&self) -> Option<&str> {
        self.fim.as_ref()?.error.as_deref()
    }

    /// A classe do erro do turno (a mesma que o pool e a frota usam).
    pub fn classe(&self) -> Option<FailureKind> {
        self.erro().map(classify)
    }

    /// O que o pool veria depois do turno: só um erro que não foi interrupção chega a `pool::on_failure`
    /// (`pool::after_turn`), e ali vira esta classe.
    pub fn classe_para_o_pool(&self) -> Option<FailureKind> {
        let fim = self.fim.as_ref()?;
        fim.error.as_deref().filter(|_| !fim.interrupted).map(classify)
    }

    /// A abertura falhou: a classe que `resume::open_resuming` recebe. No Codex, a recusa do servidor é
    /// `Gone`; nos outros, o texto passa por `resume::classify`.
    pub fn falha_de_retomada(&self, protocolo: Protocolo) -> Option<ResumeFailure> {
        let Some(Err(m)) = &self.abertura else { return None };
        Some(if self.recusada && protocolo == Protocolo::CodexAppServer { ResumeFailure::Gone(m.clone()) } else { resume::classify(m) })
    }

    /// A fala do agente, junta.
    pub fn texto(&self) -> String {
        self.itens.iter().filter(|i| i.kind == crate::canal::timeline::ItemKind::Assistant).filter_map(|i| i.text.clone()).collect::<Vec<_>>().join("\n")
    }

    /// As ferramentas como `Nome:status` (`Bash:done`).
    pub fn ferramentas(&self) -> Vec<String> {
        self.itens
            .iter()
            .filter(|i| i.tool.is_some() && i.kind == crate::canal::timeline::ItemKind::Tool)
            .map(|i| {
                let status = i.status.map(|s| serde_json::to_value(s).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()).unwrap_or_default();
                format!("{}:{status}", i.name.clone().unwrap_or_default())
            })
            .collect()
    }

    /// As ferramentas que o mapeador não reconheceu (`ToolKind::Other`): o guard das fixtures recusa.
    pub fn ferramentas_desconhecidas(&self) -> Vec<String> {
        self.itens.iter().filter(|i| i.tool == Some(ToolKind::Other)).map(|i| i.name.clone().unwrap_or_default()).collect()
    }

    /// O tipo de cada item da timeline, na ordem, como o JSON do snapshot (`assistant`, `tool`, `usage`…).
    pub fn tipos(&self) -> Vec<String> {
        self.itens.iter().map(|i| tipo_item(i.kind)).collect()
    }

    /// Os pedidos que ainda estavam pendentes quando a leitura parou.
    pub fn pedidos_pendentes(&self) -> Vec<&Pedido> {
        self.pedidos.iter().filter(|p| p.pendente).collect()
    }

    /// Os filhos numa linha que a [`Espera`] confere: `task:<id>:<op>` ou `subitem:<pai>:<tipo do item>`.
    pub fn filhos_compactos(&self) -> Vec<String> {
        self.filhos.iter().map(Filho::compacto).collect()
    }

    fn guardar(&mut self, item: Item) {
        match self.itens.iter_mut().find(|i| i.id == item.id) {
            Some(lugar) => *lugar = item,
            None => self.itens.push(item),
        }
    }
}

/// Roda as saídas pelo que o motor do protocolo faz com elas.
pub fn rodar(protocolo: Protocolo, saidas: &[Saida]) -> Resultado {
    if protocolo == Protocolo::CursorStream {
        return rodar_cursor(saidas);
    }
    let mut motor = Motor { protocolo, out: Resultado::default(), claude: claude_map::Mapper::default(), acp: opencode_map::Mapper::new("bancada"), agy: agy_map::Mapper::new("bancada"), turno: false };
    let mut ultimo = 0u64;
    for saida in saidas {
        let silencio = saida.at_ms.saturating_sub(ultimo);
        motor.out.silencio_max_ms = motor.out.silencio_max_ms.max(silencio);
        ultimo = saida.at_ms;
        motor.out.relogio_ms = saida.at_ms;
        // Abrindo, o silêncio maior que o prazo do pedido é o "não respondeu" do motor.
        // O Antigravity não tem esse prazo: o processo é o turno e o laço só lê a próxima linha.
        if protocolo != Protocolo::AgyStream && motor.out.abertura.is_none() && silencio > PRAZO_PEDIDO_MS {
            motor.out.abertura = Some(Err(format!("O {} não respondeu a {}", protocolo.nome(), protocolo.pedido_de_abertura())));
            return motor.out;
        }
        let now = EPOCH_MS + saida.at_ms as i64;
        match &saida.evento {
            Evento::Linha(line) => {
                // Como o `read_loop` de cada motor: a linha que não é JSON é pulada.
                let Ok(msg) = serde_json::from_str::<Value>(line) else {
                    motor.out.ignoradas += 1;
                    continue;
                };
                motor.dispatch(msg, now);
            }
            Evento::Fecha { stderr } => {
                motor.fechou(stderr.as_deref());
                return motor.out;
            }
        }
    }
    motor.out
}

/// O Cursor pelo `read_turn` de verdade. A fonte devolve silêncio quando o próximo `atMs` passa de
/// `quiet_after`; não há relógio de parede. O fim da lista é EOF (o processo acabou), não silêncio.
fn rodar_cursor(saidas: &[Saida]) -> Resultado {
    let mut motor = Motor {
        protocolo: Protocolo::CursorStream,
        out: Resultado::default(),
        claude: claude_map::Mapper::default(),
        acp: opencode_map::Mapper::new("bancada"),
        agy: agy_map::Mapper::new("bancada"),
        turno: true,
    };
    let agora = Arc::new(AtomicU64::new(0));
    let mut fonte = FonteCursor { pendentes: saidas.iter().cloned().collect(), agora_ms: agora.clone(), ignoradas: 0, stderr: None, silencio_max_ms: 0 };
    let mut mapper = cursor_map::Mapper::new("bancada");
    let rt = tokio::runtime::Builder::new_current_thread().build().expect("runtime do cursor na bancada");
    let done = rt.block_on(cursor_map::read_turn(
        &mut mapper,
        &mut fonte,
        |outs| {
            for out in outs {
                match out {
                    cursor_map::Out::Item(item) => motor.out.guardar(*item),
                    cursor_map::Out::Delta { item_id, delta, .. } => motor.out.deltas.push((item_id, delta)),
                    cursor_map::Out::Session(id) => motor.abriu(&id),
                    cursor_map::Out::Done(_) => {}
                }
            }
        },
        || EPOCH_MS + agora.load(Ordering::Relaxed) as i64,
    ));
    motor.out.ignoradas = fonte.ignoradas;
    motor.out.silencio_max_ms = fonte.silencio_max_ms;
    motor.out.relogio_ms = agora.load(Ordering::Relaxed);
    if let Some(result) = done {
        motor.terminou(result);
    } else {
        let erro = fonte.stderr.as_deref().map(|s| cursor_map::error_from_stderr(&s.lines().map(str::to_string).collect::<Vec<_>>())).unwrap_or_else(|| "O Cursor terminou sem responder".into());
        motor.terminou(TurnResult { interrupted: false, error: Some(erro), duration_ms: None });
        motor.out.caiu = true;
    }
    motor.out
}

/// As linhas do transcript como a `Source` do `read_turn`. O `Fake` dos testes do mapeador devolve
/// silêncio quando a lista acaba; aqui o silêncio é o próximo `atMs` além de `quiet_after`.
struct FonteCursor {
    pendentes: VecDeque<Saida>,
    agora_ms: Arc<AtomicU64>,
    ignoradas: usize,
    stderr: Option<String>,
    silencio_max_ms: u64,
}

impl cursor_map::Source for FonteCursor {
    async fn next(&mut self, quiet: Option<std::time::Duration>) -> CursorRead {
        loop {
            let Some(proxima) = self.pendentes.front() else {
                return CursorRead::Eof;
            };
            let agora = self.agora_ms.load(Ordering::Relaxed);
            let espera = proxima.at_ms.saturating_sub(agora);
            if let Some(limite) = quiet {
                let limite_ms = u64::try_from(limite.as_millis()).unwrap_or(u64::MAX);
                if espera > limite_ms {
                    self.silencio_max_ms = self.silencio_max_ms.max(espera);
                    return CursorRead::Quiet;
                }
            }
            let saida = self.pendentes.pop_front().expect("a frente acabou de ser lida");
            self.silencio_max_ms = self.silencio_max_ms.max(saida.at_ms.saturating_sub(agora));
            self.agora_ms.store(saida.at_ms, Ordering::Relaxed);
            match saida.evento {
                Evento::Linha(line) => {
                    if serde_json::from_str::<Value>(&line).is_err() {
                        self.ignoradas += 1;
                        continue;
                    }
                    return CursorRead::Line(line);
                }
                Evento::Fecha { stderr } => {
                    self.stderr = stderr;
                    return CursorRead::Eof;
                }
            }
        }
    }
}

/// Toca e roda.
pub fn simular(roteiro: &Roteiro) -> Result<Resultado, String> {
    Ok(rodar(roteiro.protocolo, &tocar(roteiro)?))
}

/// Abre uma sessão pela bancada, como o `open_resumed`/`open_fresh` dos motores: o id ou a classe da falha.
pub fn abrir(roteiro: &Roteiro) -> Result<String, ResumeFailure> {
    let resultado = simular(roteiro).map_err(ResumeFailure::Fatal)?;
    match resultado.falha_de_retomada(roteiro.protocolo) {
        Some(falha) => Err(falha),
        None => resultado.sessao().map(str::to_string).ok_or_else(|| ResumeFailure::Transient("a sessão não abriu".into())),
    }
}

struct Motor {
    protocolo: Protocolo,
    out: Resultado,
    claude: claude_map::Mapper,
    acp: opencode_map::Mapper,
    agy: agy_map::Mapper,
    /// Há um turno aberto (que o processo caindo fecharia como erro).
    turno: bool,
}

impl Motor {
    fn abriu(&mut self, id: &str) {
        if self.out.abertura.is_none() {
            self.out.abertura = Some(Ok(id.to_string()));
            // No Claude e no ACP o turno começa com a mensagem que o app manda logo depois de abrir.
            self.turno = self.protocolo != Protocolo::CodexAppServer;
        }
    }

    fn recusou(&mut self, mensagem: String) {
        if self.out.abertura.is_none() {
            self.out.abertura = Some(Err(mensagem));
            self.out.recusada = true;
        }
    }

    fn terminou(&mut self, fim: TurnResult) {
        self.out.fim = Some(fim);
        self.turno = false;
    }

    fn fechou(&mut self, stderr: Option<&str>) {
        if self.out.abertura.is_none() {
            self.out.abertura = Some(Err(format!("O processo do {} fechou", self.protocolo.nome())));
            return;
        }
        if self.turno {
            // O Codex manda o stderr só para o log: o `closed` dele fecha o turno sem o motivo (`codex.rs`).
            let stderr = stderr.filter(|_| self.protocolo != Protocolo::CodexAppServer);
            let tail: Vec<String> = stderr.map(|s| s.lines().map(str::to_string).collect()).unwrap_or_default();
            let (fim, _) = turn::dropped(false, turn::stderr_reason(tail.iter()).as_deref(), self.protocolo.nome());
            self.terminou(fim);
            self.out.caiu = true;
        }
    }

    fn dispatch(&mut self, msg: Value, now: i64) {
        match self.protocolo {
            Protocolo::ClaudeStream => self.claude(msg, now),
            Protocolo::CodexAppServer => self.codex(msg, now),
            Protocolo::Acp => self.acp(msg, now),
            Protocolo::AgyStream => self.agy(msg, now),
            // O Cursor sai antes, em `rodar_cursor` (`read_turn`). Este braço não roda.
            Protocolo::CursorStream => {}
        }
    }

    /// `claude.rs`: `dispatch` + `on_out`.
    fn claude(&mut self, msg: Value, now: i64) {
        match msg.get("type").and_then(Value::as_str) {
            Some("control_request") => {
                if let Some(ask) = msg.get("request").and_then(claude_map::ask_of) {
                    let id = msg.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
                    self.pedir(id, ask.kind, ask.title);
                }
                return;
            }
            // O Claude desistiu do pedido: sai dos pendentes e continua na lista do que foi pedido.
            Some("control_cancel_request") => {
                if let Some(id) = msg.get("request_id").and_then(Value::as_str) {
                    self.resolver(id);
                }
                return;
            }
            _ => {}
        }
        for out in self.claude.feed(&msg, now) {
            match out {
                ClaudeOut::Session(id) => self.abriu(&id),
                ClaudeOut::Item(item) => self.out.guardar(*item),
                ClaudeOut::Delta { item_id, delta, .. } => self.out.deltas.push((item_id, delta)),
                ClaudeOut::Task(task) => self.out.filhos.push(Filho { tipo: "task".into(), parent: None, task: Some(task), item: None }),
                ClaudeOut::SubItem { parent, item } => self.out.filhos.push(Filho { tipo: "subitem".into(), parent: Some(parent), task: None, item: Some(*item) }),
                // O modo de permissão não entra na timeline nem no filho.
                ClaudeOut::Mode(_) => {}
                ClaudeOut::Done(result) => {
                    // O resultado antes do `init` é a abertura que falhou (o `--resume` de uma sessão que não existe).
                    if self.out.abertura.is_none() {
                        self.recusou(result.error.unwrap_or_else(|| "O Claude não abriu a sessão".into()));
                    } else {
                        self.terminou(result);
                    }
                }
            }
        }
    }

    /// `codex.rs`: `dispatch` + `on_request` + `on_notification`.
    fn codex(&mut self, msg: Value, now: i64) {
        let method = msg.get("method").and_then(Value::as_str);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match (method, msg.get("id")) {
            (None, Some(id)) if id.as_u64() == Some(CODEX_ABRIR) => match msg.get("error") {
                Some(e) => self.recusou(e.get("message").and_then(Value::as_str).unwrap_or("erro do Codex").to_string()),
                None => match msg.pointer("/result/thread/id").and_then(Value::as_str) {
                    Some(id) => self.abriu(id),
                    None => self.recusou("O Codex não devolveu a thread".into()),
                },
            },
            (None, _) => {}
            (Some(method), Some(id)) => {
                if let Some(ask) = codex_map::ask_of(method, &params) {
                    self.pedir(id_de(id), ask.kind, ask.title);
                }
            }
            (Some(method), None) => match method {
                "turn/started" => self.turno = true,
                "turn/completed" => {
                    let turn = params.get("turn").cloned().unwrap_or(Value::Null);
                    let status = turn.get("status").and_then(Value::as_str).unwrap_or("completed");
                    if let Some(item) = codex_map::turn_end(&turn, Some(now)) {
                        self.out.guardar(item);
                    }
                    let error = (status == "failed").then(|| turn.pointer("/error/message").and_then(Value::as_str).unwrap_or("O Codex não concluiu o turno").to_string());
                    self.terminou(TurnResult { interrupted: status == "interrupted", error, duration_ms: turn.get("durationMs").and_then(Value::as_i64) });
                }
                "item/started" | "item/completed" => {
                    for item in codex_map::items_of(params.get("item").unwrap_or(&Value::Null), Some(now)) {
                        self.out.guardar(item);
                    }
                }
                "item/agentMessage/delta" | "item/reasoning/summaryTextDelta" | "item/reasoning/summaryPartAdded" => {
                    if let Some((item, delta, _)) = codex_map::delta_of(method, &params) {
                        self.out.deltas.push((item, delta));
                    }
                }
                "error" if params.get("willRetry").and_then(Value::as_bool) != Some(true) => {
                    self.out.avisos.push(params.pointer("/error/message").and_then(Value::as_str).unwrap_or("erro do Codex").to_string());
                }
                // Resolvido do lado do Codex: o pendente some, como o `serverRequest/resolved` do motor.
                "serverRequest/resolved" => {
                    if let Some(id) = params.get("requestId").and_then(id_de_opt) {
                        self.resolver(&id);
                    }
                }
                _ => {}
            },
        }
    }

    /// `opencode.rs`: `dispatch` + `on_permission` + `end_turn`.
    fn acp(&mut self, msg: Value, now: i64) {
        let method = msg.get("method").and_then(Value::as_str);
        match (method, msg.get("id").and_then(Value::as_u64)) {
            (None, Some(ACP_SESSAO)) => match msg.get("error") {
                Some(e) => self.recusou(e.get("message").and_then(Value::as_str).unwrap_or("erro do OpenCode").to_string()),
                None => match msg.pointer("/result/sessionId").and_then(Value::as_str) {
                    Some(id) => self.abriu(id),
                    None => self.recusou("O OpenCode não devolveu a sessão".into()),
                },
            },
            (None, Some(ACP_PROMPT)) => {
                for out in self.acp.flush(Some(now)) {
                    self.acp_out(out);
                }
                let fim = match (msg.get("error"), msg.get("result")) {
                    (Some(e), _) => TurnResult { interrupted: false, error: Some(opencode_map::error_text(e.get("message").and_then(Value::as_str).unwrap_or("erro do OpenCode"))), duration_ms: None },
                    (None, result) => {
                        let done = result.cloned().unwrap_or(Value::Null);
                        if let Some(usage) = opencode_map::usage_item("bancada", &done, Some(now)) {
                            self.out.guardar(usage);
                        }
                        opencode_map::turn_result(&done, None)
                    }
                };
                self.terminou(fim);
            }
            (None, _) => {}
            (Some("session/request_permission"), Some(id)) => {
                if let Some(ask) = msg.get("params").and_then(opencode_map::ask_of) {
                    self.pedir(id.to_string(), ask.kind, ask.title);
                }
            }
            (Some("session/update"), None) => {
                let update = msg.pointer("/params/update").cloned().unwrap_or(Value::Null);
                for out in self.acp.feed(&update, now) {
                    self.acp_out(out);
                }
            }
            _ => {}
        }
    }

    fn pedir(&mut self, id: String, kind: &str, title: String) {
        self.out.pedidos.push(Pedido { id, kind: kind.to_string(), title, pendente: true });
    }

    fn resolver(&mut self, id: &str) {
        if id.is_empty() {
            return;
        }
        for pedido in &mut self.out.pedidos {
            if pedido.id == id {
                pedido.pendente = false;
            }
        }
    }

    /// `agy.rs`: o laço lê cada linha e aplica o mapeador. Sem prazo.
    fn agy(&mut self, msg: Value, now: i64) {
        for out in self.agy.feed(&msg, now) {
            match out {
                AgyOut::Item(item) => self.out.guardar(*item),
                AgyOut::Delta { item_id, delta, .. } => self.out.deltas.push((item_id, delta)),
                AgyOut::Session(id) => self.abriu(&id),
                AgyOut::Done(result) => self.terminou(result),
            }
        }
    }

    fn acp_out(&mut self, out: AcpOut) {
        match out {
            AcpOut::Item(item) => self.out.guardar(*item),
            AcpOut::Delta { item_id, delta, .. } => self.out.deltas.push((item_id, delta)),
            AcpOut::Mode(_) => {}
        }
    }
}

/// O que um roteiro (ou uma fixture de protocolo) promete. Toda chave é opcional; uma chave fora desta lista falha
/// a leitura (erro de digitação não passa calado).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Espera {
    /// `ok`, `erro`, `interrompido`, `caiu` ou `aberto` (o turno não acabou).
    pub fim: Option<String>,
    pub erro_contem: Option<String>,
    /// A classe do erro do turno: `rate_limited`, `auth`, `model`, `balance`, `other`.
    pub classe: Option<String>,
    /// A classe que o pool veria (`nenhuma` = o pool não age).
    pub classe_para_o_pool: Option<String>,
    /// A abertura falhou com esta classe: `gone`, `transient`, `timeout`, `fatal`.
    pub retomada: Option<String>,
    pub sessao: Option<String>,
    /// Os tipos dos pedidos, em ordem (`command`, `question`, `fileChange`…).
    pub pedidos: Option<Vec<String>>,
    /// As ferramentas, em ordem, como `Nome:status`.
    pub ferramentas: Option<Vec<String>>,
    /// O tipo de cada item da timeline, em ordem (`assistant`, `tool`, `usage`…).
    pub tipos: Option<Vec<String>>,
    /// Os filhos, em ordem: `task:<id>:<op>` ou `subitem:<pai>:<tipo do item>`.
    pub filhos: Option<Vec<String>>,
    /// Os tipos dos pedidos que ainda estavam pendentes no fim da leitura, em ordem.
    pub pedidos_pendentes: Option<Vec<String>>,
    pub texto_contem: Option<String>,
    pub ignoradas: Option<usize>,
    pub silencio_min_ms: Option<u64>,
}

fn fim_de(r: &Resultado) -> &'static str {
    match &r.fim {
        None => "aberto",
        Some(_) if r.caiu => "caiu",
        Some(f) if f.interrupted => "interrompido",
        Some(f) if f.error.is_some() => "erro",
        Some(_) => "ok",
    }
}

fn classe_retomada(f: &ResumeFailure) -> &'static str {
    match f {
        ResumeFailure::Gone(_) => "gone",
        ResumeFailure::Transient(_) => "transient",
        ResumeFailure::Timeout(_) => "timeout",
        ResumeFailure::Fatal(_) => "fatal",
    }
}

/// O que não bateu (vazio = tudo certo). `expand` traduz os placeholders (`{{session:1}}`) da promessa.
pub fn conferir(espera: &Espera, r: &Resultado, protocolo: Protocolo, expand: &dyn Fn(&str) -> String) -> Vec<String> {
    let mut erros = Vec::new();
    let mut igual = |chave: &str, quer: String, tem: String| {
        if quer != tem {
            erros.push(format!("{chave}: esperava {quer:?}, veio {tem:?}"));
        }
    };
    if let Some(fim) = &espera.fim {
        igual("fim", fim.clone(), fim_de(r).into());
    }
    if let Some(parte) = &espera.erro_contem {
        let erro = r.erro().unwrap_or("").to_string();
        if !erro.contains(parte.as_str()) {
            igual("erroContem", parte.clone(), erro);
        }
    }
    if let Some(classe) = &espera.classe {
        igual("classe", classe.clone(), r.classe().map(|k| k.code().to_string()).unwrap_or_else(|| "nenhuma".into()));
    }
    if let Some(classe) = &espera.classe_para_o_pool {
        igual("classeParaOPool", classe.clone(), r.classe_para_o_pool().map(|k| k.code().to_string()).unwrap_or_else(|| "nenhuma".into()));
    }
    if let Some(retomada) = &espera.retomada {
        igual("retomada", retomada.clone(), r.falha_de_retomada(protocolo).map(|f| classe_retomada(&f).to_string()).unwrap_or_else(|| "abriu".into()));
    }
    if let Some(sessao) = &espera.sessao {
        igual("sessao", expand(sessao), r.sessao().unwrap_or("").to_string());
    }
    if let Some(pedidos) = &espera.pedidos {
        igual("pedidos", pedidos.join(","), r.pedidos.iter().map(|p| p.kind.clone()).collect::<Vec<_>>().join(","));
    }
    if let Some(ferramentas) = &espera.ferramentas {
        igual("ferramentas", ferramentas.join(","), r.ferramentas().join(","));
    }
    if let Some(tipos) = &espera.tipos {
        igual("tipos", tipos.join(","), r.tipos().join(","));
    }
    if let Some(filhos) = &espera.filhos {
        igual("filhos", filhos.join(","), r.filhos_compactos().join(","));
    }
    if let Some(pendentes) = &espera.pedidos_pendentes {
        igual("pedidosPendentes", pendentes.join(","), r.pedidos_pendentes().iter().map(|p| p.kind.clone()).collect::<Vec<_>>().join(","));
    }
    if let Some(parte) = &espera.texto_contem {
        let texto = r.texto();
        if !texto.contains(&expand(parte)) {
            igual("textoContem", parte.clone(), texto);
        }
    }
    if let Some(n) = espera.ignoradas {
        igual("ignoradas", n.to_string(), r.ignoradas.to_string());
    }
    if let Some(ms) = espera.silencio_min_ms
        && r.silencio_max_ms < ms
    {
        igual("silencioMinMs", format!(">= {ms}"), r.silencio_max_ms.to_string());
    }
    erros
}

impl Filho {
    fn compacto(&self) -> String {
        match self.tipo.as_str() {
            "task" => {
                let id = self.task.as_ref().and_then(|t| t.get("taskId")).and_then(Value::as_str).unwrap_or("");
                let op = self.task.as_ref().and_then(|t| t.get("op")).and_then(Value::as_str).unwrap_or("");
                format!("task:{id}:{op}")
            }
            "subitem" => {
                let tipo = self.item.as_ref().map(|i| tipo_item(i.kind)).unwrap_or_default();
                format!("subitem:{}:{tipo}", self.parent.as_deref().unwrap_or(""))
            }
            outro => outro.to_string(),
        }
    }
}

/// O nome do tipo do item, o mesmo do JSON (`assistant`, `usage`, `turnEnd`…).
fn tipo_item(kind: ItemKind) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn id_de(v: &Value) -> String {
    id_de_opt(v).unwrap_or_default()
}

fn id_de_opt(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string).or_else(|| v.as_u64().map(|n| n.to_string())).or_else(|| v.as_i64().map(|n| n.to_string()))
}
