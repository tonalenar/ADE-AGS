//! O detector de chamada de ferramenta repetida: a mesma ferramenta com os mesmos argumentos, de novo e de
//! novo, sem mensagem nova da pessoa no meio. É o laço "mesma ferramenta sem progresso", que a tela não
//! denuncia (o terminal segue escrevendo). Ideia do `repeat-tool-reminder` do deepseek-harness (MIT),
//! reimplementada aqui.
//!
//! A chave é o JSON CANÔNICO de ferramenta + argumentos (chaves de objeto em ordem, sem espaço), resumido
//! num hash estável (FNV-1a de 64 bits): o mesmo `cargo test` com os argumentos em outra ordem é a mesma
//! chamada, e a chave sobrevive ao reinício (vai para o `client_id` dos avisos).
//!
//! A escada é 3, 5 e 8: cada degrau avisa UMA vez. Uma mensagem humana (o prompt que abre um turno) zera.
//! Só lê e avisa quem supervisiona (orquestrador, timeline do Vigia): nunca escreve no integrante nem veta.
//! Puro: sem relógio, sem disco.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// Os degraus: na 3ª, na 5ª e na 8ª chamada idêntica sai um aviso.
pub const STEPS: [u32; 3] = [3, 5, 8];
/// Quantas chaves diferentes se lembra por turno (um turno longo não cresce sem fim).
const MAX_KEYS: usize = 256;

/// O JSON canônico de um valor: objetos com as chaves em ordem, sem espaço. Puro.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// FNV-1a de 64 bits: estável entre versões e execuções (o `DefaultHasher` não promete isso).
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// A chave de uma chamada: o hash do JSON canônico `{"args": …, "tool": …}`. Pura.
pub fn call_key(tool: &str, args: &Value) -> String {
    let call = serde_json::json!({ "tool": tool, "args": args });
    format!("{:016x}", fnv1a(&canonical_json(&call)))
}

/// Um degrau alcançado: a chamada e quantas vezes ela já veio.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repeat {
    pub key: String,
    pub name: String,
    pub summary: String,
    pub count: u32,
    /// O degrau (3, 5 ou 8) que este aviso marca.
    pub step: u32,
    pub at_ms: i64,
}

/// A contagem das chamadas desde a última mensagem humana.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counter {
    counts: HashMap<String, u32>,
    order: Vec<String>,
}

impl Counter {
    /// Uma mensagem humana: tudo volta a zero.
    pub fn reset(&mut self) {
        self.counts.clear();
        self.order.clear();
    }

    /// Conta uma chamada. Devolve o degrau, se esta chamada é a 3ª, a 5ª ou a 8ª igual.
    pub fn record(&mut self, key: &str, name: &str, summary: &str, at_ms: i64) -> Option<Repeat> {
        if key.is_empty() {
            return None;
        }
        let count = match self.counts.get_mut(key) {
            Some(n) => {
                *n += 1;
                *n
            }
            None => {
                if self.order.len() >= MAX_KEYS {
                    let old = self.order.remove(0);
                    self.counts.remove(&old);
                }
                self.order.push(key.to_string());
                self.counts.insert(key.to_string(), 1);
                1
            }
        };
        STEPS.contains(&count).then(|| Repeat { key: key.to_string(), name: name.to_string(), summary: summary.to_string(), count, step: count, at_ms })
    }
}

/// Uma chamada vista (para quem lê uma lista pronta, como o vigia do chat).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Call {
    pub key: String,
    pub name: String,
    pub summary: String,
}

/// O degrau mais alto de cada chamada repetida numa lista (na ordem em que foram feitas). Pura.
pub fn highest_steps(calls: &[Call]) -> Vec<Repeat> {
    let mut counter = Counter::default();
    let mut best: Vec<Repeat> = Vec::new();
    for call in calls {
        if let Some(hit) = counter.record(&call.key, &call.name, &call.summary, 0) {
            match best.iter_mut().find(|r| r.key == hit.key) {
                Some(slot) => *slot = hit,
                None => best.push(hit),
            }
        }
    }
    best
}
