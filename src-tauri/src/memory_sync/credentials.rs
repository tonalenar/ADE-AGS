use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine;
use ring::constant_time::verify_slices_are_equal;
use ring::rand::{SecureRandom, SystemRandom};
use tauri::Manager;

pub(crate) const ENV_MODE: &str = "ADE_MEMSYNC_ASKPASS_MODE";
pub(crate) const ENV_ADDR: &str = "ADE_MEMSYNC_ASKPASS_ADDR";
pub(crate) const ENV_NONCE: &str = "ADE_MEMSYNC_ASKPASS_NONCE";
pub(crate) const ENV_HOST: &str = "ADE_MEMSYNC_ASKPASS_HOST";

const ASKPASS_IO_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_LINE_BYTES: usize = 4096;

/// String sensível zerada ao sair de escopo.
pub(crate) struct WipeString(pub(crate) String);

impl Drop for WipeString {
    fn drop(&mut self) {
        // SAFETY: preencher UTF-8 com zeros mantém UTF-8 válido antes de limpar.
        unsafe {
            self.0.as_mut_vec().fill(0);
        }
        self.0.clear();
    }
}

/// Ponto de entrada quando o executável (`ags` ou `ade-ags`) é chamado pelo git via `GIT_ASKPASS`.
/// Só ativa quando `ADE_MEMSYNC_ASKPASS_MODE=1` está no ambiente.
pub fn askpass_entry() -> Option<i32> {
    if std::env::var_os(ENV_MODE).as_deref() != Some(std::ffi::OsStr::new("1")) {
        return None;
    }
    let code = match run_askpass_helper() {
        Ok(()) => 0,
        Err(msg) => {
            eprintln!("[ade-memory-sync] {msg}");
            1
        }
    };
    Some(code)
}

fn run_askpass_helper() -> Result<(), String> {
    let addr = std::env::var(ENV_ADDR).map_err(|_| "Endereço askpass ausente.")?;
    let nonce = WipeString(std::env::var(ENV_NONCE).map_err(|_| "Nonce askpass ausente.")?);
    let expected_host = std::env::var(ENV_HOST).map_err(|_| "Host esperado askpass ausente.")?;
    let prompt = std::env::args()
        .nth(1)
        .ok_or_else(|| "Prompt do git ausente.".to_string())?;
    let secret = fetch_credential_over_loopback(&addr, &nonce.0, &prompt, &expected_host)?;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{}", secret.0).map_err(|e| format!("Falha ao responder ao git: {e}"))?;
    stdout
        .flush()
        .map_err(|e| format!("Falha ao descarregar resposta ao git: {e}"))?;
    Ok(())
}

/// Servidor loopback efêmero que entrega usuário e token apenas durante um comando git e para o host esperado.
pub(crate) struct EphemeralAskpass {
    addr: SocketAddr,
    nonce: WipeString,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl EphemeralAskpass {
    pub(crate) fn start(expected_host: &str, git_user: &str, token: &str) -> Result<Self, String> {
        let host = expected_host.trim();
        let user = git_user.trim();
        if host.is_empty() || host.contains(['\r', '\n', '\0']) {
            return Err("Host inválido para autenticação git.".into());
        }
        if user.is_empty() || user.contains(['\r', '\n', '\0']) {
            return Err("Usuário git inválido para autenticação.".into());
        }
        if token.is_empty() || token.contains(['\r', '\n', '\0']) {
            return Err("Token inválido para entrega via askpass.".into());
        }

        let nonce = random_hex(32)?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Não foi possível abrir canal loopback efêmero: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("Não foi possível ler porta loopback efêmero: {e}"))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_bg = stop.clone();
        let expected_nonce = WipeString(nonce.clone());
        let expected_host = host.to_string();
        let git_user = user.to_string();
        let token_owned = WipeString(token.to_string());

        let thread = std::thread::spawn(move || {
            serve_askpass(
                listener,
                stop_bg,
                expected_nonce,
                expected_host,
                git_user,
                token_owned,
            );
        });

        Ok(Self {
            addr,
            nonce: WipeString(nonce),
            stop,
            thread: Some(thread),
        })
    }

    pub(crate) fn env_vars(&self, helper_exe: &Path) -> Vec<(String, String)> {
        let helper = crate::util::external_path(helper_exe)
            .to_string_lossy()
            .into_owned();
        vec![
            ("GIT_ASKPASS".into(), helper),
            (ENV_MODE.into(), "1".into()),
            (ENV_ADDR.into(), self.addr.to_string()),
            (ENV_NONCE.into(), self.nonce.0.clone()),
            (ENV_HOST.into(), self.host_hint()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            ("GCM_INTERACTIVE".into(), "never".into()),
        ]
    }

    fn host_hint(&self) -> String {
        // Mantido apenas em variável de verificação quando usado pelo helper próprio; não contém segredo.
        String::new()
    }

    pub(crate) fn env_vars_for_host(&self, helper_exe: &Path, expected_host: &str) -> Vec<(String, String)> {
        let mut vars = self.env_vars(helper_exe);
        if let Some((_, val)) = vars.iter_mut().find(|(k, _)| k == ENV_HOST) {
            *val = expected_host.to_string();
        }
        vars
    }

    #[cfg(test)]
    pub(crate) fn addr(&self) -> SocketAddr {
        self.addr
    }

    #[cfg(test)]
    pub(crate) fn nonce(&self) -> &str {
        &self.nonce.0
    }
}

impl Drop for EphemeralAskpass {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn random_hex(num_bytes: usize) -> Result<String, String> {
    let rng = SystemRandom::new();
    let mut buf = vec![0u8; num_bytes];
    rng.fill(&mut buf)
        .map_err(|_| "Falha ao gerar nonce aleatório.".to_string())?;
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    buf.fill(0);
    Ok(hex)
}

fn serve_askpass(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    expected_nonce: WipeString,
    expected_host: String,
    git_user: String,
    token: WipeString,
) {
    loop {
        let Ok((mut stream, _)) = listener.accept() else {
            break;
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let _ = stream.set_read_timeout(Some(ASKPASS_IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(ASKPASS_IO_TIMEOUT));
        let Some(line) = read_limited_line(&stream, MAX_LINE_BYTES) else {
            continue;
        };
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let Some((req_nonce, req_query)) = trimmed.split_once(' ') else {
            continue;
        };
        if verify_slices_are_equal(req_nonce.as_bytes(), expected_nonce.0.as_bytes()).is_err() {
            continue;
        }
        let query = req_query.trim();
        let kind = match query {
            "user" => Some("user"),
            "pass" => Some("pass"),
            other => prompt_matches_host(other, &expected_host),
        };
        let Some(kind) = kind else {
            continue;
        };
        let reply = if kind == "user" {
            git_user.as_str()
        } else {
            token.0.as_str()
        };
        let _ = stream.write_all(reply.as_bytes());
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
    }
}

fn read_limited_line(stream: &TcpStream, limit: usize) -> Option<String> {
    use std::io::Read;
    let mut reader = BufReader::new(stream.take((limit + 1) as u64));
    let mut line = String::new();
    let n = reader.read_line(&mut line).ok()?;
    if n == 0 || line.len() > limit {
        return None;
    }
    Some(line)
}

/// Verifica se o prompt do git pede usuário/senha exatamente para o host esperado (HTTPS, ou HTTP só em loopback).
pub(crate) fn prompt_matches_host(prompt: &str, expected_host: &str) -> Option<&'static str> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    let kind = if lower.starts_with("username") {
        "user"
    } else if lower.starts_with("password") {
        "pass"
    } else {
        return None;
    };

    let url_str = extract_url_from_prompt(trimmed)?;
    let parsed = url::Url::parse(url_str).ok()?;
    let actual_host = parsed.host_str()?.to_ascii_lowercase();
    let expected = expected_host.trim().to_ascii_lowercase();
    let expected_url = url::Url::parse(&format!("https://{expected}")).ok()?;
    let expected_host_only = expected_url.host_str()?.to_ascii_lowercase();
    let is_loopback = matches!(expected_host_only.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]");

    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        _ => return None,
    }

    if actual_host != expected_host_only {
        return None;
    }
    if let Some(expected_port) = expected_url.port() {
        if parsed.port_or_known_default() != Some(expected_port) {
            return None;
        }
    } else if !is_loopback && parsed.port().is_some_and(|p| p != 443) {
        return None;
    }
    Some(kind)
}

fn extract_url_from_prompt(prompt: &str) -> Option<&str> {
    if let Some(start) = prompt.find('\'')
        && let Some(rel_end) = prompt[start + 1..].find('\'')
    {
        return Some(&prompt[start + 1..start + 1 + rel_end]);
    }
    prompt
        .split_whitespace()
        .find(|token| token.starts_with("https://") || token.starts_with("http://"))
        .map(|s| s.trim_end_matches([':', ',', '\'', '"']))
}

fn is_loopback_addr(addr: &str) -> bool {
    if let Ok(sock) = addr.parse::<SocketAddr>() {
        return sock.ip().is_loopback();
    }
    let Some((host, port)) = addr.rsplit_once(':') else {
        return false;
    };
    port.parse::<u16>().is_ok()
        && matches!(
            host.to_ascii_lowercase().as_str(),
            "127.0.0.1" | "localhost" | "[::1]"
        )
}

pub(crate) fn fetch_credential_over_loopback(
    addr: &str,
    nonce: &str,
    prompt: &str,
    expected_host: &str,
) -> Result<WipeString, String> {
    if !is_loopback_addr(addr) {
        return Err("Endereço askpass fora do loopback foi recusado.".into());
    }
    if nonce.is_empty() || nonce.contains(['\r', '\n', '\0', ' ']) {
        return Err("Nonce askpass inválido.".into());
    }
    if prompt.contains(['\r', '\n', '\0']) {
        return Err("Prompt askpass inválido.".into());
    }
    if prompt_matches_host(prompt, expected_host).is_none() {
        return Err(format!(
            "O git pediu credencial para outro destino que não corresponde a {expected_host}."
        ));
    }

    let sock: SocketAddr = addr
        .parse()
        .map_err(|_| "Endereço loopback askpass inválido.".to_string())?;
    let mut stream = TcpStream::connect_timeout(&sock, ASKPASS_IO_TIMEOUT)
        .map_err(|_| "Não foi possível conectar ao canal efêmero de credenciais.".to_string())?;
    let _ = stream.set_read_timeout(Some(ASKPASS_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(ASKPASS_IO_TIMEOUT));

    let req = WipeString(format!("{nonce} {prompt}\n"));
    stream
        .write_all(req.0.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|_| "Falha ao enviar pedido ao canal efêmero de credenciais.".to_string())?;

    let mut raw = String::new();
    let mut reader = BufReader::new(stream);
    reader
        .read_line(&mut raw)
        .map_err(|_| "Falha ao ler resposta do canal efêmero de credenciais.".to_string())?;
    let trimmed = raw.trim_end_matches(['\r', '\n']).to_string();
    // SAFETY: zera buffer temporário que recebeu o segredo.
    unsafe {
        raw.as_mut_vec().fill(0);
    }
    raw.clear();
    if trimmed.is_empty() {
        return Err("Canal efêmero recusou a solicitação de credencial.".into());
    }
    Ok(WipeString(trimmed))
}

pub(crate) fn helper_program(app: Option<&tauri::AppHandle>) -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) { "ags.exe" } else { "ags" };
    if let Ok(current) = std::env::current_exe() {
        let sibling = current.with_file_name(exe_name);
        if sibling.is_file() {
            return Ok(sibling);
        }
        if current.is_file() {
            return Ok(current);
        }
    }
    if let Some(app) = app
        && let Ok(res_dir) = app.path().resource_dir()
    {
        let candidate = res_dir.join(exe_name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("Executável auxiliar do askpass não encontrado.".into())
}

pub(crate) fn sanitize_error(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        out = out.replace(secret, "[redigido]");
        let b64 = base64::engine::general_purpose::STANDARD.encode(secret.as_bytes());
        if !b64.is_empty() {
            out = out.replace(&b64, "[redigido]");
        }
    }
    out
}
