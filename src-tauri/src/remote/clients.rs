//! Pareamento e tokens de clientes remotos do servidor MCP HTTP.
//!
//! O token bruto (32 bytes aleatórios em base64url) é devolvido uma única vez no pareamento.
//! No keyring do sistema fica apenas o hash SHA-256 do token junto com os metadados do cliente.

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Arc;
use std::sync::{LazyLock, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const INDEX_KEY: &str = "index";
const TOKEN_BYTES: usize = 32;
const MAX_CLIENTS: usize = 64;

static STORE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Último uso de cada cliente, só em memória: gravar no keyring a cada requisição reescrevia o índice inteiro sob o
/// lock global (a até 20/s por cliente). Some com o processo, como o resto do estado volátil do servidor.
static LAST_SEEN: LazyLock<Mutex<std::collections::HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn note_seen(client_id: &str, now: i64) {
    let mut map = LAST_SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let seen = map.entry(client_id.to_string()).or_insert(now);
    *seen = (*seen).max(now);
}

fn seen_of(client: &mut RemoteClient) {
    let seen = LAST_SEEN.lock().unwrap_or_else(|e| e.into_inner()).get(&client.id).copied();
    if let Some(seen) = seen {
        client.last_seen_at = Some(client.last_seen_at.map_or(seen, |stored| stored.max(seen)));
    }
}

#[cfg(test)]
static TEST_DEFAULT_MEM: LazyLock<Arc<Mutex<HashMap<String, String>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Nível de permissão atribuído a um cliente remoto no pareamento.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    Read,
    Browser,
    Agents,
    All,
}

/// Metadados públicos de um cliente remoto pareado (sem token nem hash).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteClient {
    pub id: String,
    pub name: String,
    pub preset: Preset,
    pub folders: Vec<String>,
    pub default_folder: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub last_seen_at: Option<i64>,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredClient {
    #[serde(flatten)]
    client: RemoteClient,
    token_hash: String,
}

/// Normaliza caminhos de pasta para comparação entre sistemas (equivalente a `comparablePath`).
pub fn normalize_folder(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    let without_trailing = trimmed.trim_end_matches('/');
    let normalized = if without_trailing.is_empty() && trimmed.starts_with('/') {
        "/"
    } else {
        without_trailing
    };
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized.to_string()
    }
}

#[derive(Debug, Clone)]
enum StoreBackend {
    #[cfg_attr(test, allow(dead_code))]
    Keyring(String),
    #[cfg(test)]
    Memory(Arc<Mutex<HashMap<String, String>>>),
}

/// Armazém isolável de clientes no keyring do SO.
#[derive(Debug, Clone)]
pub struct ClientStore {
    backend: StoreBackend,
}

impl ClientStore {
    pub fn default_store() -> Self {
        #[cfg(test)]
        {
            Self {
                backend: StoreBackend::Memory(TEST_DEFAULT_MEM.clone()),
            }
        }
        #[cfg(not(test))]
        {
            Self {
                backend: StoreBackend::Keyring(service_name()),
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(_tag: &str) -> Self {
        Self {
            backend: StoreBackend::Memory(Arc::new(Mutex::new(HashMap::new()))),
        }
    }

    fn read_raw(&self, key: &str) -> Result<Option<String>, String> {
        match &self.backend {
            StoreBackend::Keyring(service) => {
                let entry = keyring::Entry::new(service, key)
                    .map_err(|_| "O cofre do sistema não está disponível".to_string())?;
                match entry.get_password() {
                    Ok(raw) => Ok(Some(raw)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(_) => Err("Não foi possível acessar o cofre do sistema".into()),
                }
            }
            #[cfg(test)]
            StoreBackend::Memory(map) => Ok(map.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()),
        }
    }

    fn write_raw(&self, key: &str, value: &str) -> Result<(), String> {
        match &self.backend {
            StoreBackend::Keyring(service) => {
                let entry = keyring::Entry::new(service, key)
                    .map_err(|_| "O cofre do sistema não está disponível".to_string())?;
                entry
                    .set_password(value)
                    .map_err(|_| "Não foi possível atualizar o índice de clientes remotos no cofre".into())
            }
            #[cfg(test)]
            StoreBackend::Memory(map) => {
                map.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key.to_string(), value.to_string());
                Ok(())
            }
        }
    }

    fn load_index(&self) -> Result<Vec<StoredClient>, String> {
        match self.read_raw(INDEX_KEY)? {
            Some(raw) => serde_json::from_str(&raw)
                .map_err(|_| "O índice de clientes remotos no cofre está inválido".into()),
            None => Ok(Vec::new()),
        }
    }

    fn save_index(&self, entries: &[StoredClient]) -> Result<(), String> {
        let raw = serde_json::to_string(entries)
            .map_err(|_| "Não foi possível serializar o índice de clientes remotos".to_string())?;
        self.write_raw(INDEX_KEY, &raw)
    }

    pub fn pair(
        &self,
        name: &str,
        preset: Preset,
        folders: Vec<String>,
        default_folder: &str,
        ttl_days: Option<u32>,
    ) -> Result<(RemoteClient, String), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Informe um nome para o cliente remoto".into());
        }
        let default_folder = default_folder.trim();
        if default_folder.is_empty() {
            return Err("Informe a pasta padrão do cliente remoto".into());
        }

        let mut clean_folders: Vec<String> = Vec::new();
        for folder in folders
            .into_iter()
            .chain(std::iter::once(default_folder.to_string()))
        {
            let trimmed = folder.trim();
            if trimmed.is_empty() {
                continue;
            }
            let norm = normalize_folder(trimmed);
            if !clean_folders.iter().any(|existing| normalize_folder(existing) == norm) {
                clean_folders.push(trimmed.to_string());
            }
        }

        let token = generate_token()?;
        let token_hash = hash_token(&token);
        let now = crate::util::now_ts();
        let expires_at = ttl_days
            .filter(|days| *days > 0)
            .map(|days| now.saturating_add(i64::from(days).saturating_mul(86_400)));

        let client = RemoteClient {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.chars().take(120).collect(),
            preset,
            folders: clean_folders,
            default_folder: default_folder.to_string(),
            created_at: now,
            expires_at,
            last_seen_at: None,
            revoked: false,
        };

        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut index = self.load_index()?;
        let active_count = index.iter().filter(|entry| !entry.client.revoked).count();
        if active_count >= MAX_CLIENTS {
            return Err(
                "Limite de 64 clientes remotos ativos atingido. Revogue um cliente antes de parear outro."
                    .into(),
            );
        }
        index.push(StoredClient {
            client: client.clone(),
            token_hash,
        });
        self.save_index(&index)?;

        Ok((client, token))
    }

    pub fn authenticate(&self, bearer: &str) -> Option<RemoteClient> {
        self.authenticate_at(bearer, crate::util::now_ts())
    }

    pub fn authenticate_at(&self, bearer: &str, now: i64) -> Option<RemoteClient> {
        let bearer = bearer.trim();
        if bearer.is_empty() {
            return None;
        }
        let candidate_hash = hash_token(bearer);

        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let index = self.load_index().ok()?;

        // Percorre todas as entradas sem sair cedo para manter a comparação em tempo constante.
        let mut matched_idx: Option<usize> = None;
        for (idx, entry) in index.iter().enumerate() {
            if constant_time_eq(candidate_hash.as_bytes(), entry.token_hash.as_bytes()) {
                matched_idx = Some(idx);
            }
        }
        let idx = matched_idx?;
        let entry = &index[idx];
        if entry.client.revoked {
            return None;
        }
        if entry.client.expires_at.is_some_and(|exp| exp <= now) {
            return None;
        }
        note_seen(&entry.client.id, now);
        let mut authenticated = entry.client.clone();
        seen_of(&mut authenticated);
        Some(authenticated)
    }

    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut index = self.load_index()?;
        let Some(entry) = index.iter_mut().find(|entry| entry.client.id == id) else {
            return Ok(false);
        };
        entry.client.revoked = true;
        self.save_index(&index)?;
        Ok(true)
    }

    pub fn list(&self) -> Vec<RemoteClient> {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.load_index()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.client)
            .filter(|client| !client.revoked)
            .map(|mut client| {
                seen_of(&mut client);
                client
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn raw_index_json(&self) -> Option<String> {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.read_raw(INDEX_KEY).ok().flatten()
    }
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Não foi possível gerar bytes aleatórios seguros para o token".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn service_name() -> String {
    let data_dir = crate::util::datadir::ags_home().unwrap_or_default();
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in data_dir.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("ade-ags.remote.{hash:016x}")
}

pub fn pair(
    name: &str,
    preset: Preset,
    folders: Vec<String>,
    default_folder: &str,
    ttl_days: Option<u32>,
) -> Result<(RemoteClient, String), String> {
    ClientStore::default_store().pair(name, preset, folders, default_folder, ttl_days)
}

pub fn authenticate(bearer: &str) -> Option<RemoteClient> {
    ClientStore::default_store().authenticate(bearer)
}

pub fn revoke(id: &str) -> Result<bool, String> {
    ClientStore::default_store().revoke(id)
}

pub fn list() -> Vec<RemoteClient> {
    ClientStore::default_store().list()
}
