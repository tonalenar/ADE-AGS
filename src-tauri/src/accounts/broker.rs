//! Intermediário local de credenciais para contas por API key.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const TICKET_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_ANCESTORS: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BrokerError {
    Forbidden,
    TicketReused,
    UnknownTicket,
    TicketNotReady,
    MissingCredential,
    AccountMismatch,
}

impl BrokerError {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Forbidden => "O processo não pertence ao agente autorizado para esta credencial.",
            Self::TicketReused => "O ticket de credencial já foi usado.",
            Self::UnknownTicket => "O ticket de credencial é inválido ou expirou.",
            Self::TicketNotReady => "O agente ainda está iniciando; tente novamente.",
            Self::MissingCredential => {
                "A credencial da conta não está disponível no chaveiro do sistema."
            }
            Self::AccountMismatch => {
                "A conta ou o provedor não corresponde ao ticket de credencial."
            }
        }
    }
}

struct Ticket {
    account_id: String,
    agent_pid: Option<u32>,
    issued_at: Instant,
    in_use: bool,
    redeemed: bool,
}

#[derive(Default)]
pub(crate) struct Broker {
    tickets: Mutex<HashMap<String, Ticket>>,
    ready: Condvar,
}

impl Broker {
    fn insert(&self, account_id: &str, agent_pid: Option<u32>) -> String {
        let ticket = uuid::Uuid::new_v4().simple().to_string();
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        tickets.retain(|_, item| item.issued_at.elapsed() < TICKET_TTL);
        tickets.insert(
            ticket.clone(),
            Ticket {
                account_id: account_id.to_string(),
                agent_pid,
                issued_at: Instant::now(),
                in_use: false,
                redeemed: false,
            },
        );
        ticket
    }

    pub(crate) fn issue_ticket(&self, account_id: &str, agent_pid: u32) -> String {
        self.insert(account_id, Some(agent_pid))
    }

    pub(crate) fn issue_pending_ticket(&self, account_id: &str) -> String {
        self.insert(account_id, None)
    }

    pub(crate) fn bind_ticket(&self, ticket: &str, agent_pid: u32) -> Result<(), BrokerError> {
        if agent_pid == 0 {
            return Err(BrokerError::Forbidden);
        }
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let item = tickets.get_mut(ticket).ok_or(BrokerError::UnknownTicket)?;
        item.agent_pid = Some(agent_pid);
        self.ready.notify_all();
        Ok(())
    }

    pub(crate) fn revoke_ticket(&self, ticket: &str) {
        self.tickets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(ticket);
        self.ready.notify_all();
    }

    fn redeem_with_account(
        &self,
        ticket: &str,
        account_id: &str,
        caller_pid: u32,
        mut parent: impl FnMut(u32) -> Option<u32>,
        load_key: impl FnOnce(&str) -> Option<String>,
    ) -> Result<String, BrokerError> {
        let started = Instant::now();
        {
            let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                let item = tickets.get(ticket).ok_or(BrokerError::UnknownTicket)?;
                if item.issued_at.elapsed() >= TICKET_TTL {
                    tickets.remove(ticket);
                    return Err(BrokerError::UnknownTicket);
                }
                if item.account_id != account_id {
                    return Err(BrokerError::AccountMismatch);
                }
                if item.redeemed || item.in_use {
                    return Err(BrokerError::TicketReused);
                }
                if let Some(agent_pid) = item.agent_pid {
                    if !descends_from(caller_pid, agent_pid, &mut parent) {
                        return Err(BrokerError::Forbidden);
                    }
                    tickets.get_mut(ticket).expect("ticket verificado").in_use = true;
                    break;
                }
                let remaining = Duration::from_millis(1500).saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err(BrokerError::TicketNotReady);
                }
                let waited = self
                    .ready
                    .wait_timeout(tickets, remaining)
                    .unwrap_or_else(|e| e.into_inner());
                tickets = waited.0;
                if waited.1.timed_out() {
                    return Err(BrokerError::TicketNotReady);
                }
            }
        }

        // A leitura do keyring pode bloquear: não mantenha o mutex do broker durante I/O.
        let key = load_key(account_id);
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = tickets.get_mut(ticket) {
            item.in_use = false;
            if key.is_some() {
                item.redeemed = true;
            }
        }
        self.ready.notify_all();
        key.ok_or(BrokerError::MissingCredential)
    }

    #[cfg(test)]
    pub(crate) fn redeem_with(
        &self,
        ticket: &str,
        caller_pid: u32,
        parent: impl FnMut(u32) -> Option<u32>,
        load_key: impl FnOnce(&str) -> Option<String>,
    ) -> Result<String, BrokerError> {
        self.redeem_with_account(ticket, "conta-de-teste", caller_pid, parent, load_key)
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

pub(crate) struct PendingTicket(Option<String>);

impl PendingTicket {
    pub(crate) fn new(account_id: &str) -> Self {
        Self(Some(issue_pending_ticket(account_id)))
    }

    pub(crate) fn token(&self) -> &str {
        self.0.as_deref().expect("ticket ainda ativo")
    }

    pub(crate) fn bind(&self, agent_pid: u32) -> Result<(), BrokerError> {
        bind_ticket(self.token(), agent_pid)
    }

    pub(crate) fn commit(mut self) -> String {
        self.0.take().expect("ticket ainda ativo")
    }
}

impl Drop for PendingTicket {
    fn drop(&mut self) {
        if let Some(ticket) = self.0.take() {
            revoke_ticket(&ticket);
        }
    }
}

fn global() -> &'static Broker {
    static BROKER: OnceLock<Broker> = OnceLock::new();
    BROKER.get_or_init(Broker::default)
}

/// Emite um ticket já associado ao processo raiz do agente.
#[allow(dead_code)] // Interface do contrato; o lançamento de PTY usa ticket pendente até obter o PID.
pub fn issue_ticket(account_id: &str, agent_pid: u32) -> String {
    global().issue_ticket(account_id, agent_pid)
}

pub(crate) fn issue_pending_ticket(account_id: &str) -> String {
    global().issue_pending_ticket(account_id)
}

pub(crate) fn bind_ticket(ticket: &str, agent_pid: u32) -> Result<(), BrokerError> {
    global().bind_ticket(ticket, agent_pid)
}

pub(crate) fn revoke_ticket(ticket: &str) {
    global().revoke_ticket(ticket)
}

/// Confere a conta, o provedor e a ancestralidade antes de ler o cofre.
pub(crate) fn redeem(
    ticket: &str,
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
        ticket,
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
    ticket: &str,
) -> Result<String, String> {
    if !["claude", "codex"].contains(&agent)
        || account_id.is_empty()
        || !account_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || ticket.len() != 32
        || !ticket.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("A configuração do intermediário de credenciais está inválida.".into());
    }
    let executable = ags.to_string_lossy();
    #[cfg(windows)]
    let executable = format!("\"{}\"", executable.replace('"', "\\\""));
    #[cfg(not(windows))]
    let executable = format!("'{}'", executable.replace('\'', "'\\''"));
    Ok(format!(
        "{executable} credential {agent} --account {account_id} --ticket {ticket}"
    ))
}

/// Grava somente o helper e preserva as demais preferências do perfil Claude.
pub(crate) fn write_claude_settings(
    config_dir: &std::path::Path,
    ags: &std::path::Path,
    account_id: &str,
    ticket: &str,
) -> Result<String, String> {
    let command = helper_command(ags, "claude", account_id, ticket)?;
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
        let owned_prefix = format!("credential claude --account {account_id} --ticket ");
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

/// Remove só o helper deste ticket, sem sobrescrever um helper instalado por outro lançamento.
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
    ticket: &str,
) -> Result<String, String> {
    let command = helper_command(ags, "codex", account_id, ticket)?;
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
