//! A timeline de cada aba mantida em memória e lida de forma incremental: o builder guarda o que já
//! leu e só os bytes novos do transcript passam por ele. Quem pede diz até onde já sabe (`rev` e
//! número de itens) e recebe só a cauda que mudou, não a conversa inteira (até 4 MB) a cada aviso
//! de crescimento. Ver `ipc::commands::canal::conversation_timeline_since`.
//!
//! O que já foi entregue só muda de duas formas: itens novos no fim, ou um item existente alterado
//! (o resultado de uma ferramenta, os tokens de uma mensagem). O builder diz o menor índice
//! alterado e o cache guarda isso por revisão; o pedido recebe tudo a partir do menor índice entre
//! o que ele já tem e o que mudou depois da revisão dele.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::timeline::{Builder, Item, MAX_BYTES};

/// Quantas revisões com item alterado ficam guardadas; quem pede com revisão mais velha recebe tudo.
const LOG_MAX: usize = 128;

/// Revisões únicas no processo: um cache refeito nunca reaproveita uma revisão antiga.
static REV: AtomicU64 = AtomicU64::new(1);

fn next_rev() -> u64 {
    REV.fetch_add(1, Ordering::Relaxed)
}

/// O que o pedido já tem.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Known {
    pub rev: u64,
    pub count: usize,
}

/// A resposta: troque `items[from..]` do que você tinha por `items`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDelta {
    pub rev: u64,
    pub truncated: bool,
    /// O total de itens depois de aplicar.
    pub total: usize,
    pub from: usize,
    pub items: Vec<Item>,
}

pub struct Cache {
    path: PathBuf,
    agent_id: String,
    builder: Builder,
    /// Onde a janela de leitura começou (depois da primeira linha inteira) e até onde já foi lida.
    start: u64,
    offset: u64,
    started: bool,
    truncated: bool,
    rev: u64,
    floor: u64,
    log: VecDeque<(u64, usize)>,
}

impl Cache {
    pub fn new(path: &Path, agent_id: &str) -> Self {
        Cache {
            path: path.to_path_buf(),
            agent_id: agent_id.to_string(),
            builder: Builder::default(),
            start: 0,
            offset: 0,
            started: false,
            truncated: false,
            rev: next_rev(),
            floor: 0,
            log: VecDeque::new(),
        }
    }

    fn reset(&mut self) {
        *self = Cache::new(&self.path.clone(), &self.agent_id.clone());
        self.floor = self.rev;
    }

    /// Lê o que o arquivo ganhou desde a última vez. Só linhas inteiras entram.
    pub fn advance(&mut self) -> io::Result<()> {
        let mut file = std::fs::File::open(&self.path)?;
        let len = file.metadata()?.len();
        // O arquivo encolheu (compactado) ou a janela passou de 2× o limite: recomeça do fim.
        if self.started && (len < self.offset || len.saturating_sub(self.start) > MAX_BYTES * 2) {
            self.reset();
        }
        if !self.started {
            self.truncated = len > MAX_BYTES;
            self.start = if self.truncated { len - MAX_BYTES } else { 0 };
            self.offset = self.start;
        }
        if self.started && len == self.offset {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::with_capacity((len - self.offset) as usize);
        file.take(len - self.offset).read_to_end(&mut bytes)?;
        let mut skip = 0usize;
        if !self.started {
            self.started = true;
            // Começando no meio, a primeira linha está cortada.
            if self.truncated {
                skip = bytes.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(bytes.len());
            }
        }
        let mut consumed = match bytes.iter().rposition(|&b| b == b'\n') {
            Some(i) => (i + 1).max(skip),
            None => skip,
        };
        // Sem `\n` final, a última linha só vale se já for um JSON completo.
        let rest = &bytes[consumed..];
        if !rest.is_empty() && serde_json::from_slice::<serde_json::Value>(rest).is_ok() {
            consumed = bytes.len();
        }
        for line in bytes[skip..consumed].split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
                self.builder.feed(&self.agent_id, &value);
            }
        }
        self.offset += consumed as u64;
        let dirty = self.builder.take_dirty();
        self.rev = next_rev();
        if let Some(index) = dirty {
            self.log.push_back((self.rev, index));
            while self.log.len() > LOG_MAX {
                if let Some((r, _)) = self.log.pop_front() {
                    self.floor = self.floor.max(r);
                }
            }
        }
        Ok(())
    }

    pub fn delta(&self, known: Option<Known>) -> TimelineDelta {
        let items = self.builder.items();
        let from = match known {
            Some(k) if k.rev >= self.floor && k.rev <= self.rev && k.count <= items.len() => {
                self.log.iter().filter(|(r, _)| *r > k.rev).fold(k.count, |from, (_, i)| from.min(*i))
            }
            _ => 0,
        };
        TimelineDelta { rev: self.rev, truncated: self.truncated, total: items.len(), from, items: items[from..].to_vec() }
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Mutex<Cache>>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<Mutex<Cache>>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A timeline da aba desde o que o pedido já tem. Bloqueia (lê arquivo): rode fora do runtime async.
pub fn read_since(tab_id: &str, path: &Path, agent_id: &str, known: Option<Known>) -> io::Result<TimelineDelta> {
    let cache = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let cache = map.entry(tab_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(Cache::new(path, agent_id))));
        let same = cache.lock().map(|c| c.path == path && c.agent_id == agent_id).unwrap_or(false);
        if !same {
            *cache = Arc::new(Mutex::new(Cache::new(path, agent_id)));
        }
        cache.clone()
    };
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    cache.advance()?;
    Ok(cache.delta(known))
}

/// A aba perdeu o canal: solta a timeline guardada.
pub fn forget(tab_id: &str) {
    registry().lock().unwrap_or_else(|e| e.into_inner()).remove(tab_id);
}
