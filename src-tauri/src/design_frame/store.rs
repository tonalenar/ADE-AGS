use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Nome do URI scheme registrado no Tauri (`ags-design://localhost/<id>` no macOS/Linux,
/// `http://ags-design.localhost/<id>` no Windows).
pub const SCHEME: &str = "ags-design";

/// CSP aplicada por header HTTP nas pranchetas de Design: sem rede, sem formulário, sem `<base>`.
/// Mesma lista de `DESIGN_CSP` em `src/features/canvas/design/srcdoc.ts`: bibliotecas de CDN
/// permitidas (como nos Artifacts), Google Fonts, sem rede (`connect-src 'none'`) e sem formulário.
pub const DESIGN_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/// CSP aplicada por header HTTP em quadros isolados (renders publicados, apps MCP e prévias visuais).
pub const ISOLATED_FRAME_CSP: &str = "default-src 'none'; connect-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// Limite por documento (2 MiB): cobre HTML de prancheta (≤ 1 MiB) + scripts/estilos injetados.
pub const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

/// Teto total retido em memória pelo mapa efêmero (32 MiB).
pub const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

/// Máximo de documentos simultâneos em memória.
pub const MAX_ENTRIES: usize = 128;

/// Tempo de vida padrão sem acesso antes de expirar (30 min).
pub const DEFAULT_TTL: Duration = Duration::from_secs(30 * 60);

/// Política de CSP fechada no backend: o frontend só escolhe o perfil, nunca uma string arbitrária.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FramePolicy {
    #[default]
    Design,
    Isolated,
}

impl FramePolicy {
    pub const fn csp(self) -> &'static str {
        match self {
            Self::Design => DESIGN_CSP,
            Self::Isolated => ISOLATED_FRAME_CSP,
        }
    }

    const fn hash_tag(self) -> &'static [u8] {
        match self {
            Self::Design => b"design\0",
            Self::Isolated => b"isolated\0",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StoreConfig {
    pub ttl: Duration,
    pub max_document_bytes: usize,
    pub max_total_bytes: usize,
    pub max_entries: usize,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self {
            ttl: DEFAULT_TTL,
            max_document_bytes: MAX_DOCUMENT_BYTES,
            max_total_bytes: MAX_TOTAL_BYTES,
            max_entries: MAX_ENTRIES,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredFrame {
    pub html: Vec<u8>,
    pub policy: FramePolicy,
}

struct Entry {
    html: Vec<u8>,
    policy: FramePolicy,
    touched_at: Instant,
    last_seq: u64,
}

struct StoreInner {
    entries: HashMap<String, Entry>,
    total_bytes: usize,
    seq: u64,
}

/// Mapa efêmero em memória de documentos HTML indexados por hash SHA-256.
#[derive(Clone)]
pub struct DesignFrameStore {
    inner: Arc<Mutex<StoreInner>>,
    config: StoreConfig,
}

impl Default for DesignFrameStore {
    fn default() -> Self {
        Self::new()
    }
}

impl DesignFrameStore {
    pub fn new() -> Self {
        Self::with_config(StoreConfig::default())
    }

    pub fn with_config(config: StoreConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(StoreInner {
                entries: HashMap::new(),
                total_bytes: 0,
                seq: 0,
            })),
            config,
        }
    }

    pub fn register(&self, html: String, policy: FramePolicy) -> Result<String, String> {
        self.register_at(html, policy, Instant::now())
    }

    pub fn register_at(
        &self,
        html: String,
        policy: FramePolicy,
        now: Instant,
    ) -> Result<String, String> {
        let bytes = html.into_bytes();
        let size = bytes.len();
        if size > self.config.max_document_bytes {
            return Err(format!(
                "documento HTML excede o limite de {} bytes",
                self.config.max_document_bytes
            ));
        }
        if size > self.config.max_total_bytes || self.config.max_entries == 0 {
            return Err("armazenamento de quadros sem capacidade para este documento".to_string());
        }

        let id = content_id(policy, &bytes);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        purge_expired(&mut inner, now, self.config.ttl);

        if inner.entries.contains_key(&id) {
            inner.seq = inner.seq.wrapping_add(1);
            let seq = inner.seq;
            if let Some(existing) = inner.entries.get_mut(&id) {
                existing.touched_at = now;
                existing.last_seq = seq;
            }
            return Ok(id);
        }

        while inner.entries.len() >= self.config.max_entries
            || inner.total_bytes.saturating_add(size) > self.config.max_total_bytes
        {
            if !evict_oldest(&mut inner) {
                break;
            }
        }

        inner.seq = inner.seq.wrapping_add(1);
        let seq = inner.seq;
        inner.total_bytes = inner.total_bytes.saturating_add(size);
        inner.entries.insert(
            id.clone(),
            Entry {
                html: bytes,
                policy,
                touched_at: now,
                last_seq: seq,
            },
        );
        Ok(id)
    }

    pub fn get_at(&self, id: &str, now: Instant) -> Option<StoredFrame> {
        if !is_valid_id(id) {
            return None;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let expired = inner
            .entries
            .get(id)
            .is_some_and(|e| now.saturating_duration_since(e.touched_at) >= self.config.ttl);
        if expired {
            if let Some(removed) = inner.entries.remove(id) {
                inner.total_bytes = inner.total_bytes.saturating_sub(removed.html.len());
            }
            return None;
        }
        inner.seq = inner.seq.wrapping_add(1);
        let seq = inner.seq;
        let entry = inner.entries.get_mut(id)?;
        entry.touched_at = now;
        entry.last_seq = seq;
        Some(StoredFrame {
            html: entry.html.clone(),
            policy: entry.policy,
        })
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .len()
    }

    #[cfg(test)]
    pub fn total_bytes(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .total_bytes
    }
}

pub fn is_valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn content_id(policy: FramePolicy, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(policy.hash_tag());
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

fn purge_expired(inner: &mut StoreInner, now: Instant, ttl: Duration) {
    let mut removed_bytes = 0usize;
    inner.entries.retain(|_, entry| {
        let keep = now.saturating_duration_since(entry.touched_at) < ttl;
        if !keep {
            removed_bytes = removed_bytes.saturating_add(entry.html.len());
        }
        keep
    });
    inner.total_bytes = inner.total_bytes.saturating_sub(removed_bytes);
}

fn evict_oldest(inner: &mut StoreInner) -> bool {
    let oldest_key = inner
        .entries
        .iter()
        .min_by_key(|(_, entry)| entry.last_seq)
        .map(|(k, _)| k.clone());
    let Some(key) = oldest_key else {
        return false;
    };
    if let Some(removed) = inner.entries.remove(&key) {
        inner.total_bytes = inner.total_bytes.saturating_sub(removed.html.len());
        true
    } else {
        false
    }
}
