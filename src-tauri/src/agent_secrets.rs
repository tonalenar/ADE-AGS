//! Segredos temporários pedidos por uma conversa de agente.
//!
//! O valor e o índice de validade ficam somente no cofre do sistema. O índice contém apenas
//! ids, dono e expiração; o agente recebe um id opaco e só pode consumir o valor por uma ação
//! autenticada da mesma conversa.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const INDEX: &str = "index";
const MAX_SECRETS: usize = 32;
const MAX_SECRET_BYTES: usize = 16 * 1024;
const TTL_SECS: i64 = 24 * 60 * 60;

lazy_static::lazy_static! {
    static ref STORE_LOCK: Mutex<()> = Mutex::new(());
}

#[derive(Clone, Serialize, Deserialize)]
struct Grant {
    owner: String,
    expires_at: i64,
    label: String,
    active: bool,
}

type IndexMap = HashMap<String, Grant>;

fn entry(key: &str) -> Result<keyring::Entry, String> {
    // O Keychain/Secret Service é compartilhado entre instâncias. Separe o namespace pelo
    // diretório de dados para que uma build isolada não leia nem altere as autorizações da ADE.
    let data_dir = crate::util::datadir::ags_home().unwrap_or_default();
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in data_dir.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let service = format!("ade-ags.agent-secrets.{hash:016x}");
    keyring::Entry::new(&service, key).map_err(|_| "O cofre do sistema não está disponível".into())
}

fn load_index() -> Result<IndexMap, String> {
    match entry(INDEX)?.get_password() {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|_| "O índice de segredos do cofre está inválido".into()),
        Err(keyring::Error::NoEntry) => Ok(IndexMap::new()),
        Err(_) => Err("Não foi possível acessar o cofre do sistema".into()),
    }
}

fn save_index(index: &IndexMap) -> Result<(), String> {
    let raw = serde_json::to_string(index)
        .map_err(|_| "Não foi possível atualizar o índice do cofre".to_string())?;
    entry(INDEX)?
        .set_password(&raw)
        .map_err(|_| "Não foi possível atualizar o índice do cofre".into())
}

fn delete_secret(id: &str) -> Result<(), String> {
    match entry(&format!("secret:{id}"))?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Não foi possível apagar um segredo expirado do cofre".into()),
    }
}

fn prune_locked(index: &mut IndexMap, now: i64) -> Result<(), String> {
    let expired: Vec<String> = index
        .iter()
        .filter(|(_, grant)| !grant.active || grant.expires_at <= now)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &expired {
        delete_secret(id)?;
        index.remove(id);
    }
    if !expired.is_empty() {
        save_index(index)?;
    }
    Ok(())
}

/// Salva o segredo e seus metadados de expiração no Keychain/Secret Service do sistema.
pub fn issue(owner: &str, label: &str, secret: &str) -> Result<(String, i64), String> {
    if owner.trim().is_empty() || label.trim().is_empty() {
        return Err("Faltam a conversa ou a identificação do segredo".into());
    }
    if secret.trim().is_empty() || secret.len() > MAX_SECRET_BYTES || secret.contains('\0') {
        return Err("O segredo está vazio ou ultrapassa o limite de 16 KiB".into());
    }

    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = crate::util::now_ts();
    let expires_at = now.saturating_add(TTL_SECS);
    let mut index = load_index()?;
    prune_locked(&mut index, now)?;
    if index.len() >= MAX_SECRETS {
        return Err(
            "Já existem 32 segredos temporários. Revogue um ou aguarde a expiração.".into(),
        );
    }

    let id = uuid::Uuid::new_v4().to_string();
    let grant = Grant {
        owner: owner.to_owned(),
        expires_at,
        label: label.trim().chars().take(200).collect(),
        active: false,
    };

    // Reserva primeiro o id: se o processo cair entre as gravações, o próximo ciclo remove
    // a entrada pendente sem deixar um segredo órfão no cofre.
    index.insert(id.clone(), grant);
    save_index(&index)?;
    if entry(&format!("secret:{id}"))?
        .set_password(secret)
        .is_err()
    {
        index.remove(&id);
        let _ = save_index(&index);
        return Err("Não foi possível guardar o segredo no cofre do sistema".into());
    }
    if let Some(grant) = index.get_mut(&id) {
        grant.active = true;
    }
    if save_index(&index).is_err() {
        let _ = delete_secret(&id);
        index.remove(&id);
        let _ = save_index(&index);
        return Err("Não foi possível concluir a gravação segura".into());
    }
    Ok((id, expires_at))
}

/// Lê um segredo somente para a conversa proprietária, ainda dentro da validade.
pub fn consume(owner: &str, id: &str) -> Result<String, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = crate::util::now_ts();
    let mut index = load_index()?;
    prune_locked(&mut index, now)?;
    let Some(grant) = index.get(id) else {
        return Err("Esse segredo não existe mais ou expirou".into());
    };
    if !grant.active {
        return Err("Esse segredo ainda não está disponível".into());
    }
    if grant.owner != owner {
        return Err("Esse segredo pertence a outra conversa".into());
    }
    entry(&format!("secret:{id}"))?
        .get_password()
        .map_err(|_| "Não foi possível acessar o segredo no cofre do sistema".into())
}

/// Revoga uma autorização da própria conversa. Retorna `false` se já não existir.
pub fn revoke(owner: &str, id: &str) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = crate::util::now_ts();
    let mut index = load_index()?;
    prune_locked(&mut index, now)?;
    let Some(grant) = index.get(id) else {
        return Ok(false);
    };
    if grant.owner != owner {
        return Err("Esse segredo pertence a outra conversa".into());
    }
    delete_secret(id)?;
    index.remove(id);
    save_index(&index)?;
    Ok(true)
}

/// Remove valores vencidos/pedentes do cofre; falha de acesso não impede a abertura do app.
pub fn cleanup_expired() {
    let Ok(_guard) = STORE_LOCK.lock() else {
        return;
    };
    let Ok(mut index) = load_index() else { return };
    let _ = prune_locked(&mut index, crate::util::now_ts());
}
