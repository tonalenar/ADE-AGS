//! Cofre de logins do usuário guardado exclusivamente no keyring do SO.
//!
//! O índice (`index`) contém apenas metadados (origem, usuário, rótulo, datas e agentes permitidos);
//! nenhuma senha entra no índice nem em logs, arquivos ou resultados de tools de agente.
//! Cada senha fica na entrada `pw:<id>` do serviço `ade-ags.vault.<hash do datadir>`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod test;

const INDEX: &str = "index";
const MAX_ENTRIES: usize = 256;
const MAX_USERNAME_CHARS: usize = 320;
const MAX_LABEL_CHARS: usize = 200;
const MAX_PASSWORD_BYTES: usize = 16 * 1024;

/// Sufixos públicos compostos mais comuns que nunca podem ser usados como domínio de curinga (`*.com.br`).
const COMPOUND_PUBLIC_SUFFIXES: &[&str] = &[
    "com.br", "net.br", "org.br", "gov.br", "edu.br", "co.uk", "org.uk", "ac.uk", "gov.uk",
    "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp", "com.ar", "com.mx", "com.es",
    "co.nz", "co.in", "com.cn", "com.tw", "com.hk", "com.sg", "co.kr", "co.za", "com.tr",
    "com.pl", "com.pt",
];

lazy_static::lazy_static! {
    static ref STORE_LOCK: Mutex<()> = Mutex::new(());
}

#[cfg(test)]
std::thread_local! {
    static TEST_SERVICE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
lazy_static::lazy_static! {
    /// Keyring em memória para testes isolados (o mock embutido do crate `keyring` v3
    /// não persiste valores entre chamadas distintas a `Entry::new`).
    static ref TEST_KEYRING: Mutex<std::collections::HashMap<(String, String), String>> =
        Mutex::new(std::collections::HashMap::new());
}

#[cfg(test)]
fn set_test_service(service: String) {
    TEST_SERVICE.with(|slot| {
        *slot.borrow_mut() = Some(service);
    });
}

/// Entrada de metadados de um login no cofre (nunca contém a senha).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String,
    pub origin: String,
    pub username: String,
    pub label: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub allowed_agents: Vec<String>,
}

/// Senha mantida em memória somente pelo tempo estritamente necessário e zerada no `Drop`.
pub struct VaultSecret(String);

impl VaultSecret {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for VaultSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VaultSecret([redacted])")
    }
}

impl Drop for VaultSecret {
    fn drop(&mut self) {
        crate::accounts::broker::wipe_secret(&mut self.0);
    }
}

fn service_name() -> String {
    #[cfg(test)]
    if let Some(service) = TEST_SERVICE.with(|slot| slot.borrow().clone()) {
        return service;
    }
    // O Keychain/Secret Service é compartilhado entre instâncias. Separa o namespace pelo
    // diretório de dados para que uma build isolada não leia nem altere o cofre real.
    let data_dir = crate::util::datadir::ags_home().unwrap_or_default();
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in data_dir.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("ade-ags.vault.{hash:016x}")
}

fn read_keyring(key: &str) -> Result<Option<String>, String> {
    #[cfg(test)]
    if let Some(service) = TEST_SERVICE.with(|slot| slot.borrow().clone()) {
        return Ok(TEST_KEYRING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(service, key.to_string()))
            .cloned());
    }
    match keyring::Entry::new(&service_name(), key)
        .map_err(|_| "O cofre do sistema não está disponível".to_string())?
        .get_password()
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Não foi possível acessar o cofre do sistema".into()),
    }
}

fn write_keyring(key: &str, value: &str) -> Result<(), String> {
    #[cfg(test)]
    if let Some(service) = TEST_SERVICE.with(|slot| slot.borrow().clone()) {
        TEST_KEYRING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((service, key.to_string()), value.to_string());
        return Ok(());
    }
    keyring::Entry::new(&service_name(), key)
        .map_err(|_| "O cofre do sistema não está disponível".to_string())?
        .set_password(value)
        .map_err(|_| "Não foi possível gravar no cofre do sistema".into())
}

fn delete_keyring(key: &str) -> Result<(), String> {
    #[cfg(test)]
    if let Some(service) = TEST_SERVICE.with(|slot| slot.borrow().clone()) {
        TEST_KEYRING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(service, key.to_string()));
        return Ok(());
    }
    match keyring::Entry::new(&service_name(), key)
        .map_err(|_| "O cofre do sistema não está disponível".to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Não foi possível apagar a entrada do cofre".into()),
    }
}

fn pw_key(id: &str) -> String {
    format!("pw:{id}")
}

fn load_index() -> Result<Vec<VaultEntry>, String> {
    match read_keyring(INDEX)? {
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|_| "O índice do cofre de logins está inválido".into()),
        None => Ok(Vec::new()),
    }
}

fn save_index(entries: &[VaultEntry]) -> Result<(), String> {
    let raw = serde_json::to_string(entries)
        .map_err(|_| "Não foi possível serializar o índice do cofre".to_string())?;
    write_keyring(INDEX, &raw).map_err(|_| "Não foi possível salvar o índice do cofre".into())
}

fn delete_password(id: &str) -> Result<(), String> {
    delete_keyring(&pw_key(id)).map_err(|_| "Não foi possível apagar a senha do cofre".into())
}

fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

fn is_valid_wildcard_domain(domain: &str) -> bool {
    if domain.is_empty()
        || domain.len() > 253
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..")
    {
        return false;
    }
    if domain.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    if labels.len() == 2 && COMPOUND_PUBLIC_SUFFIXES.contains(&domain) {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// Extrai domínio e porta de uma origem curinga (`*.exemplo.com[:port]` ou `https://*.exemplo.com[:port]`).
fn parse_wildcard_origin(raw: &str) -> Result<Option<(String, Option<u16>, bool)>, String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://*.") {
        return Err(
            "Origens curinga só são aceitas em HTTPS (http público não é permitido no cofre)"
                .into(),
        );
    }
    let (with_scheme, rest) = if let Some(rest) = trimmed.strip_prefix("*.") {
        (false, rest)
    } else if lower.starts_with("https://*.") {
        (true, &trimmed["https://*.".len()..])
    } else {
        return Ok(None);
    };

    let synthetic = format!("https://wildcard.{rest}");
    let url = url::Url::parse(&synthetic)
        .map_err(|_| "A origem curinga precisa estar no formato *.dominio.com".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A origem não pode conter usuário ou senha na URL".into());
    }
    let host = url
        .host_str()
        .ok_or("A origem curinga precisa ter um domínio válido")?
        .to_ascii_lowercase();
    let Some(domain) = host.strip_prefix("wildcard.") else {
        return Err("A origem curinga precisa estar no formato *.dominio.com".into());
    };
    if !is_valid_wildcard_domain(domain) {
        return Err(
            "A origem curinga exige um domínio registrável válido (ex.: *.exemplo.com)".into(),
        );
    }
    Ok(Some((domain.to_string(), url.port(), with_scheme)))
}

/// Normaliza uma origem para `scheme://host[:port]` (ou `*.dominio[:port]` para curingas),
/// recusando esquemas inseguros (HTTP público, `javascript:`, `ftp:`, etc.).
pub fn normalize_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Informe a origem do site".into());
    }
    if let Some((domain, port, with_scheme)) = parse_wildcard_origin(trimmed)? {
        let prefix = if with_scheme { "https://*." } else { "*." };
        return Ok(match port {
            Some(p) => format!("{prefix}{domain}:{p}"),
            None => format!("{prefix}{domain}"),
        });
    }

    let url = url::Url::parse(trimmed)
        .map_err(|_| "A origem precisa ser uma URL válida (https://... ou http://localhost)".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A origem não pode conter usuário ou senha na URL".into());
    }
    let host = url
        .host_str()
        .ok_or("A origem precisa ter um host válido")?
        .to_ascii_lowercase();
    match url.scheme() {
        "https" => {}
        "http" if is_local_host(&host) => {}
        _ => {
            return Err(
                "Somente origens HTTPS (ou HTTP para localhost/127.0.0.1) são permitidas no cofre"
                    .into(),
            );
        }
    }
    Ok(match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    })
}

fn validate_username(username: &str) -> Result<String, String> {
    let clean = username.trim();
    if clean.is_empty() || clean.chars().count() > MAX_USERNAME_CHARS {
        return Err("Informe um usuário válido (até 320 caracteres)".into());
    }
    Ok(clean.to_string())
}

fn validate_label(label: &str, fallback_origin: &str) -> Result<String, String> {
    let clean = label.trim();
    if clean.chars().count() > MAX_LABEL_CHARS {
        return Err("O rótulo ultrapassa 200 caracteres".into());
    }
    if clean.is_empty() {
        Ok(fallback_origin
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .chars()
            .take(MAX_LABEL_CHARS)
            .collect())
    } else {
        Ok(clean.to_string())
    }
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > MAX_PASSWORD_BYTES || password.contains('\0') {
        return Err("A senha está vazia ou ultrapassa o limite de 16 KiB".into());
    }
    Ok(())
}

/// Lista todos os logins cadastrados (apenas metadados, nunca senhas).
pub fn list() -> Result<Vec<VaultEntry>, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_index()
}

/// Adiciona um novo login ao cofre, normalizando a origem e salvando a senha apenas no keyring.
pub fn add(
    origin: &str,
    username: &str,
    label: &str,
    password: &str,
) -> Result<VaultEntry, String> {
    let normalized_origin = normalize_origin(origin)?;
    let clean_username = validate_username(username)?;
    let clean_label = validate_label(label, &normalized_origin)?;
    validate_password(password)?;

    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_index()?;
    if entries.len() >= MAX_ENTRIES {
        return Err(
            "O cofre atingiu o limite de 256 logins. Remova um antes de adicionar outro.".into(),
        );
    }

    let id = uuid::Uuid::new_v4().to_string();
    let item = VaultEntry {
        id: id.clone(),
        origin: normalized_origin,
        username: clean_username,
        label: clean_label,
        created_at: crate::util::now_ts(),
        last_used_at: None,
        allowed_agents: Vec::new(),
    };

    write_keyring(&pw_key(&id), password)
        .map_err(|_| "Não foi possível guardar a senha no cofre do sistema".to_string())?;

    entries.push(item.clone());
    if let Err(err) = save_index(&entries) {
        let _ = delete_password(&id);
        return Err(err);
    }
    Ok(item)
}

/// Atualiza usuário, rótulo e/ou senha de um login existente.
pub fn update(
    id: &str,
    username: Option<&str>,
    label: Option<&str>,
    password: Option<&str>,
) -> Result<VaultEntry, String> {
    if let Some(pw) = password {
        validate_password(pw)?;
    }

    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_index()?;
    let Some(item) = entries.iter_mut().find(|candidate| candidate.id == id) else {
        return Err("Login não encontrado no cofre".into());
    };

    if let Some(u) = username {
        item.username = validate_username(u)?;
    }
    if let Some(l) = label {
        item.label = validate_label(l, &item.origin)?;
    }
    let updated = item.clone();

    if let Some(pw) = password {
        write_keyring(&pw_key(id), pw)
            .map_err(|_| "Não foi possível atualizar a senha no cofre do sistema".to_string())?;
    }
    save_index(&entries)?;
    Ok(updated)
}

/// Remove um login do índice e apaga sua senha do keyring.
pub fn remove(id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_index()?;
    let before = entries.len();
    entries.retain(|candidate| candidate.id != id);
    if entries.len() == before {
        return Err("Login não encontrado no cofre".into());
    }
    delete_password(id)?;
    save_index(&entries)?;
    Ok(())
}

/// Verifica se `page_url` corresponde à origem cadastrada em `entry_origin`.
/// Aceita mesma origem exata, ou subdomínio do mesmo domínio registrável **somente**
/// quando `entry_origin` é um curinga (`*.dominio.com` ou `https://*.dominio.com`).
pub fn origin_matches(entry_origin: &str, page_url: &str) -> bool {
    let Ok(page) = url::Url::parse(page_url.trim()) else {
        return false;
    };
    if !page.username().is_empty() || page.password().is_some() {
        return false;
    }
    let Some(page_host) = page.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };

    if let Ok(Some((domain, port, _))) = parse_wildcard_origin(entry_origin) {
        if page.scheme() != "https" {
            return false;
        }
        if page.port() != port {
            return false;
        }
        return page_host == domain || page_host.ends_with(&format!(".{domain}"));
    }

    let Ok(expected) = normalize_origin(entry_origin) else {
        return false;
    };
    let Ok(actual) = normalize_origin(page_url) else {
        return false;
    };
    expected == actual
}

/// Recupera a senha pelo id (uso interno do backend).
#[cfg(test)]
pub(crate) fn password_for_fill(id: &str) -> Result<VaultSecret, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries = load_index()?;
    if !entries.iter().any(|candidate| candidate.id == id) {
        return Err("Login não encontrado no cofre".into());
    }
    let pw = read_keyring(&pw_key(id))?
        .ok_or_else(|| "Não foi possível ler a senha no cofre do sistema".to_string())?;
    Ok(VaultSecret(pw))
}

/// Valida `origin_matches` para `page_url`, atualiza `last_used_at` e devolve a senha
/// apenas se a origem da página corresponder à cadastrada.
pub fn secret_for_fill(id: &str, page_url: &str) -> Result<VaultSecret, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_index()?;
    let Some(item) = entries.iter_mut().find(|candidate| candidate.id == id) else {
        return Err("not_found: Login não encontrado no cofre".into());
    };
    if !origin_matches(&item.origin, page_url) {
        return Err(
            "origin_mismatch: A página atual não corresponde à origem cadastrada para este login"
                .into(),
        );
    }
    let pw = read_keyring(&pw_key(id))?
        .ok_or_else(|| "Não foi possível ler a senha no cofre do sistema".to_string())?;
    item.last_used_at = Some(crate::util::now_ts());
    let _ = save_index(&entries);
    Ok(VaultSecret(pw))
}

/// Registra permissão permanente ("Sempre permitir") para `agent` usar este login.
pub fn allow_agent(id: &str, agent: &str) -> Result<VaultEntry, String> {
    let clean = agent.trim();
    if clean.is_empty() {
        return Err("Identificação do agente inválida".into());
    }
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_index()?;
    let Some(item) = entries.iter_mut().find(|candidate| candidate.id == id) else {
        return Err("Login não encontrado no cofre".into());
    };
    if !item.allowed_agents.iter().any(|existing| existing == clean) {
        item.allowed_agents.push(clean.to_string());
    }
    let updated = item.clone();
    save_index(&entries)?;
    Ok(updated)
}

/// Revoga a permissão "Sempre permitir" de `agent` para este login.
pub fn revoke_agent(id: &str, agent: &str) -> Result<VaultEntry, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_index()?;
    let Some(item) = entries.iter_mut().find(|candidate| candidate.id == id) else {
        return Err("Login não encontrado no cofre".into());
    };
    item.allowed_agents.retain(|existing| existing != agent);
    let updated = item.clone();
    save_index(&entries)?;
    Ok(updated)
}

/// Informa se `agent` já tem permissão permanente para este login.
#[cfg(test)]
pub fn is_allowed(id: &str, agent: &str) -> bool {
    let Ok(_guard) = STORE_LOCK.lock() else {
        return false;
    };
    let Ok(entries) = load_index() else {
        return false;
    };
    entries
        .iter()
        .find(|candidate| candidate.id == id)
        .is_some_and(|item| item.allowed_agents.iter().any(|existing| existing == agent))
}

#[tauri::command]
pub fn vault_list() -> Result<Vec<VaultEntry>, String> {
    list()
}

#[tauri::command]
pub fn vault_add(
    origin: String,
    username: String,
    label: String,
    password: String,
) -> Result<VaultEntry, String> {
    add(&origin, &username, &label, &password)
}

#[tauri::command]
pub fn vault_update(
    id: String,
    username: Option<String>,
    label: Option<String>,
    password: Option<String>,
) -> Result<VaultEntry, String> {
    update(&id, username.as_deref(), label.as_deref(), password.as_deref())
}

#[tauri::command]
pub fn vault_remove(id: String) -> Result<(), String> {
    remove(&id)
}

#[tauri::command]
pub fn vault_allow_agent(id: String, agent: String) -> Result<VaultEntry, String> {
    allow_agent(&id, &agent)
}

#[tauri::command]
pub fn vault_revoke_agent(id: String, agent: String) -> Result<VaultEntry, String> {
    revoke_agent(&id, &agent)
}

#[tauri::command]
pub fn vault_secret_for_fill(id: String, page_url: String) -> Result<String, String> {
    let secret = secret_for_fill(&id, &page_url)?;
    Ok(secret.as_str().to_string())
}
