//! Intermediário local de credenciais para contas por API key.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_ANCESTORS: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BrokerError {
    Forbidden,
    GrantNotReady,
    MissingCredential,
    AccountMismatch,
}

impl BrokerError {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Forbidden => "O processo não pertence ao agente autorizado para esta credencial.",
            Self::GrantNotReady => "A sessão do agente ainda está iniciando; tente novamente.",
            Self::MissingCredential => {
                "A credencial da conta não está disponível no chaveiro do sistema."
            }
            Self::AccountMismatch => {
                "A conta ou o provedor não corresponde à credencial solicitada."
            }
        }
    }
}

struct Grant {
    account_id: String,
    agent_pid: u32,
}

#[derive(Default)]
pub(crate) struct Broker {
    grants: Mutex<HashMap<String, Grant>>,
    ready: Condvar,
}

impl Broker {
    pub(crate) fn issue_grant(&self, account_id: &str) -> String {
        let grant_id = uuid::Uuid::new_v4().simple().to_string();
        self.grants.lock().unwrap_or_else(|e| e.into_inner()).insert(
            grant_id.clone(),
            Grant {
                account_id: account_id.to_string(),
                agent_pid: 0,
            },
        );
        grant_id
    }

    pub(crate) fn bind_grant(&self, grant_id: &str, agent_pid: u32) -> Result<(), BrokerError> {
        if agent_pid == 0 {
            return Err(BrokerError::Forbidden);
        }
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        let item = grants.get_mut(grant_id).ok_or(BrokerError::Forbidden)?;
        item.agent_pid = agent_pid;
        self.ready.notify_all();
        Ok(())
    }

    pub(crate) fn revoke_grant(&self, grant_id: &str) {
        self.grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(grant_id);
        self.ready.notify_all();
    }

    pub(crate) fn has_account_grant(&self, account_id: &str) -> bool {
        self.grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|grant| grant.account_id == account_id)
    }

    pub(crate) fn has_other_account_grant(&self, account_id: &str, excluded_id: &str) -> bool {
        self.grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|(id, grant)| id != excluded_id && grant.account_id == account_id)
    }

    pub(crate) fn redeem_with_account(
        &self,
        account_id: &str,
        caller_pid: u32,
        parent: impl FnMut(u32) -> Option<u32> + Copy,
        load_key: impl FnOnce(&str) -> Option<String>,
    ) -> Result<String, BrokerError> {
        let started = Instant::now();
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        let grant_id = loop {
            if let Some(id) = grants
                .iter()
                .find(|(_, grant)| {
                    grant.account_id == account_id
                        && grant.agent_pid > 0
                        && descends_from(caller_pid, grant.agent_pid, parent)
                })
                .map(|(id, _)| id.clone())
            {
                break id;
            }
            if !grants
                .values()
                .any(|grant| grant.account_id == account_id && grant.agent_pid == 0)
            {
                return Err(BrokerError::Forbidden);
            }
            let remaining = Duration::from_millis(1500).saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(BrokerError::GrantNotReady);
            }
            let waited = self
                .ready
                .wait_timeout(grants, remaining)
                .unwrap_or_else(|error| error.into_inner());
            grants = waited.0;
            if waited.1.timed_out() {
                return Err(BrokerError::GrantNotReady);
            }
        };
        drop(grants);

        // A leitura do keyring pode bloquear: não mantenha o mutex do broker durante I/O.
        let mut key = load_key(account_id).ok_or(BrokerError::MissingCredential)?;
        let still_authorized = self
            .grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&grant_id)
            .is_some_and(|grant| {
                grant.account_id == account_id
                    && descends_from(caller_pid, grant.agent_pid, parent)
            });
        if !still_authorized {
            wipe_secret(&mut key);
            return Err(BrokerError::Forbidden);
        }
        Ok(key)
    }
}

fn descends_from(caller: u32, agent: u32, mut parent: impl FnMut(u32) -> Option<u32>) -> bool {
    if caller == 0 || agent == 0 {
        return false;
    }
    let mut current = caller;
    for _ in 0..MAX_ANCESTORS {
        if current == agent {
            return true;
        }
        if current <= 1 {
            return false;
        }
        match parent(current) {
            Some(next) if next != 0 && next != current => current = next,
            _ => return false,
        }
    }
    false
}

pub(crate) struct PendingGrant(Option<String>);

impl PendingGrant {
    pub(crate) fn new(account_id: &str) -> Self {
        Self(Some(global().issue_grant(account_id)))
    }

    pub(crate) fn id(&self) -> &str {
        self.0.as_deref().expect("concessão ainda ativa")
    }

    pub(crate) fn bind(&self, agent_pid: u32) -> Result<(), BrokerError> {
        global().bind_grant(self.id(), agent_pid)
    }

    pub(crate) fn commit(mut self) -> String {
        self.0.take().expect("concessão ainda ativa")
    }
}

impl Drop for PendingGrant {
    fn drop(&mut self) {
        if let Some(grant_id) = self.0.take() {
            revoke_grant(&grant_id);
        }
    }
}

fn global() -> &'static Broker {
    static BROKER: OnceLock<Broker> = OnceLock::new();
    BROKER.get_or_init(Broker::default)
}

pub(crate) fn revoke_grant(grant_id: &str) {
    global().revoke_grant(grant_id)
}

pub(crate) fn has_account_grant(account_id: &str) -> bool {
    global().has_account_grant(account_id)
}

pub(crate) fn has_other_account_grant(account_id: &str, excluded_id: &str) -> bool {
    global().has_other_account_grant(account_id, excluded_id)
}

/// Confere a conta, o provedor e a sessão viva antes de ler o cofre.
pub(crate) fn redeem(
    account_id: &str,
    agent_id: &str,
    caller_pid: Option<u32>,
    db: &crate::database::DbConnection,
) -> Result<String, BrokerError> {
    let caller_pid = caller_pid
        .filter(|pid| *pid > 0)
        .ok_or(BrokerError::Forbidden)?;
    let kind = crate::accounts::kind_for_account_for_agent(db, account_id, agent_id)
        .map_err(|_| BrokerError::AccountMismatch)?;
    if kind != crate::accounts::AccountKind::ApiKey {
        return Err(BrokerError::AccountMismatch);
    }
    global().redeem_with_account(
        account_id,
        caller_pid,
        crate::terminal::parent_pid,
        crate::accounts::secrets::load,
    )
}

/// Zera os bytes antes de liberar a alocação. Os bytes zero formam UTF-8 válido.
pub(crate) fn wipe_secret(secret: &mut String) {
    // SAFETY: preencher a sequência UTF-8 com zero preserva a validade da String.
    unsafe {
        secret.as_mut_vec().fill(0);
    }
    secret.clear();
}

fn helper_command(
    ags: &std::path::Path,
    agent: &str,
    account_id: &str,
) -> Result<String, String> {
    if !["claude", "codex"].contains(&agent)
        || account_id.is_empty()
        || !account_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("A configuração do intermediário de credenciais está inválida.".into());
    }
    let executable = ags.to_string_lossy();
    #[cfg(windows)]
    let executable = format!("\"{}\"", executable.replace('"', "\\\""));
    #[cfg(not(windows))]
    let executable = format!("'{}'", executable.replace('\'', "'\\''"));
    Ok(format!(
        "{executable} credential {agent} --account {account_id}"
    ))
}

/// Grava somente o helper e preserva as demais preferências do perfil Claude.
pub(crate) fn write_claude_settings(
    config_dir: &std::path::Path,
    ags: &std::path::Path,
    account_id: &str,
) -> Result<String, String> {
    let command = helper_command(ags, "claude", account_id)?;
    let path = config_dir.join("settings.json");
    let mut settings = if path.exists() {
        if std::fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err(
                "O settings.json da conta é um link simbólico; a configuração foi recusada.".into(),
            );
        }
        let raw = std::fs::read_to_string(&path)
            .map_err(|_| "Não foi possível ler as configurações da conta Claude.".to_string())?;
        serde_json::from_str::<serde_json::Value>(&raw).map_err(|_| {
            "O settings.json da conta Claude está inválido e foi preservado.".to_string()
        })?
    } else {
        serde_json::json!({})
    };
    let object = settings
        .as_object_mut()
        .ok_or("O settings.json da conta Claude precisa ser um objeto JSON.")?;
    if let Some(existing) = object
        .get("apiKeyHelper")
        .and_then(serde_json::Value::as_str)
    {
        let owned_prefix = format!("credential claude --account {account_id}");
        if existing != command && !existing.contains(&owned_prefix) {
            return Err(
                "Já existe um apiKeyHelper definido neste perfil Claude; ele foi preservado."
                    .into(),
            );
        }
    }
    object.insert(
        "apiKeyHelper".into(),
        serde_json::Value::String(command.clone()),
    );
    let body = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    write_private_atomic(&path, &body)?;
    Ok(command)
}

/// Remove só o helper deste perfil, sem sobrescrever um helper de terceiros.
pub(crate) fn clear_claude_settings(
    config_dir: &std::path::Path,
    expected: &str,
) -> Result<(), String> {
    let path = config_dir.join("settings.json");
    if !path.exists() {
        return Ok(());
    }
    if std::fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Ok(());
    }
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(());
    };
    let Some(object) = settings.as_object_mut() else {
        return Ok(());
    };
    if object
        .get("apiKeyHelper")
        .and_then(serde_json::Value::as_str)
        != Some(expected)
    {
        return Ok(());
    }
    object.remove("apiKeyHelper");
    let body = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    write_private_atomic(&path, &body)
}

/// Configuração de provedor Codex com autenticação sob demanda pelo broker.
pub(crate) fn codex_provider_config(
    ags: &std::path::Path,
    account_id: &str,
) -> Result<String, String> {
    let command = helper_command(ags, "codex", account_id)?;
    let command = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    Ok(format!(
        "model_provider = \"ade-openai\"\n\n[model_providers.ade-openai]\nname = \"OpenAI via ADE AGS\"\nbase_url = \"https://api.openai.com/v1\"\nwire_api = \"responses\"\n\n[model_providers.ade-openai.auth]\ncommand = {command}\nrefresh_interval_ms = 0\n"
    ))
}

fn write_private_atomic(path: &std::path::Path, body: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("A pasta das configurações da conta está inválida.")?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "Não foi possível preparar as configurações da conta.".to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        use std::io::Write;
        let mut file = options.open(&temporary).map_err(|_| {
            "Não foi possível criar as configurações privadas da conta.".to_string()
        })?;
        file.write_all(body)
            .map_err(|_| "Não foi possível gravar as configurações da conta.".to_string())?;
        file.sync_all()
            .map_err(|_| "Não foi possível concluir as configurações da conta.".to_string())?;
        std::fs::rename(&temporary, path)
            .map_err(|_| "Não foi possível ativar as configurações da conta.".to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
