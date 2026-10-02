//! ADE-owned Google OAuth grants. No router process and no credential extraction.
//! Tokens and OAuth client settings live exclusively in the native credential vault.

use crate::database::DbConnection;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const SERVICE: &str = "com.ade.antigravity.oauth";
const CLIENT: &str = "desktop-client";
const FLOW_TTL: Duration = Duration::from_secs(600);
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const INFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

#[derive(Serialize, Deserialize, Clone)]
struct Client {
    client_id: String,
    client_secret: String,
}
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Grant {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) expires_at: i64,
    client_id: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    client_id: Option<String>,
    configured: bool,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub email: String,
    pub connected: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    flow_id: String,
    authorization_url: String,
}
#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Progress {
    Pending,
    Connected { account: Account },
    Failed { message: String },
}
struct Flow {
    progress: Progress,
    expires: Instant,
    abort: tokio::task::AbortHandle,
}
lazy_static::lazy_static! {
    static ref FLOWS: Mutex<HashMap<String, Flow>> = Mutex::new(HashMap::new());
    static ref REFRESH_LOCKS: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> = Mutex::new(HashMap::new());
}

fn vault(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|_| "O cofre do sistema está indisponível".into())
}
fn save<T: Serialize>(id: &str, value: &T) -> Result<(), String> {
    vault(id)?
        .set_password(&serde_json::to_string(value).map_err(|_| "Formato OAuth inválido")?)
        .map_err(|_| "Não foi possível salvar no cofre do sistema".into())
}
fn load<T: serde::de::DeserializeOwned>(id: &str) -> Result<T, String> {
    let raw = vault(id)?
        .get_password()
        .map_err(|_| "Credenciais ausentes: conecte esta conta novamente")?;
    serde_json::from_str(&raw)
        .map_err(|_| "Credenciais inválidas: conecte esta conta novamente".into())
}
fn valid_client(id: &str) -> bool {
    id.len() <= 512
        && id.ends_with(".apps.googleusercontent.com")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
}
fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cliente HTTP indisponível".into())
}
async fn body(response: reqwest::Response) -> Result<serde_json::Value, String> {
    if !response.status().is_success() {
        return Err(format!(
            "Google recusou a solicitação OAuth (HTTP {}). Verifique o cliente, o consentimento e o acesso da conta.",
            response.status().as_u16()
        ));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Falha ao receber a resposta OAuth")?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err("Resposta OAuth excedeu o limite".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Resposta OAuth inválida".into())
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn authorization(client_id: &str, redirect: &str, state: &str, verifier: &str) -> String {
    let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        (
            "scope",
            "openid email profile https://www.googleapis.com/auth/cloud-platform",
        ),
        ("state", state),
        ("code_challenge", challenge(verifier).as_str()),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    url.into()
}
fn callback(request: &str, port: u16, state: &str) -> Result<String, String> {
    let line = request.lines().next().ok_or("Callback vazio")?;
    let fields: Vec<_> = line.split_whitespace().collect();
    if fields.len() != 3
        || fields[0] != "GET"
        || !fields[1].starts_with("/oauth/callback?")
        || !matches!(fields[2], "HTTP/1.1" | "HTTP/1.0")
    {
        return Err("Callback inválido".into());
    }
    let uri = url::Url::parse(&format!("http://127.0.0.1:{port}{}", fields[1]))
        .map_err(|_| "Callback inválido")?;
    if uri.path() != "/oauth/callback" || uri.fragment().is_some() {
        return Err("Rota OAuth inválida".into());
    }
    let pairs: Vec<_> = uri.query_pairs().collect();
    let value = |key| {
        let values: Vec<_> = pairs
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
            .collect();
        if values.len() == 1 {
            Some(values[0])
        } else {
            None
        }
    };
    if value("state") != Some(state) {
        return Err("Estado OAuth inválido".into());
    }
    if value("error").is_some() {
        return Err("O consentimento OAuth foi recusado".into());
    }
    value("code")
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .map(str::to_string)
        .ok_or("Código OAuth ausente".into())
}

#[tauri::command]
pub async fn antigravity_oauth_config() -> Result<Config, String> {
    tokio::task::spawn_blocking(|| {
        Ok(match load::<Client>(CLIENT) {
            Ok(client) => Config {
                client_id: Some(client.client_id),
                configured: true,
            },
            Err(_) => Config {
                client_id: None,
                configured: false,
            },
        })
    })
    .await
    .map_err(|_| "Falha ao consultar configuração OAuth".to_string())?
}
#[tauri::command]
pub async fn antigravity_oauth_configure(
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if !valid_client(&client_id)
        || client_secret.is_empty()
        || client_secret.len() > 512
        || client_secret.chars().any(char::is_control)
    {
        return Err("Informe um cliente OAuth Google de aplicativo para computador válido".into());
    }
    tokio::task::spawn_blocking(move || {
        save(
            CLIENT,
            &Client {
                client_id,
                client_secret,
            },
        )
    })
    .await
    .map_err(|_| "Falha ao salvar cliente OAuth".to_string())?
}
pub(crate) fn list(conn: &rusqlite::Connection) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare("SELECT id,name,email FROM antigravity_oauth_accounts ORDER BY name,id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Account {
                id: r.get(0)?,
                name: r.get(1)?,
                email: r.get(2)?,
                connected: false,
            })
        })
        .map_err(|e| e.to_string())?;
    let client = load::<Client>(CLIENT).ok();
    rows.map(|row| {
        let mut account = row.map_err(|e| e.to_string())?;
        account.connected = load::<Grant>(&account.id).is_ok_and(|grant| {
            client
                .as_ref()
                .is_some_and(|c| c.client_id == grant.client_id)
        });
        Ok(account)
    })
    .collect()
}
#[tauri::command]
pub async fn antigravity_oauth_accounts(app: AppHandle) -> Result<Vec<Account>, String> {
    let db = app.state::<DbConnection>().inner().clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        list(&conn)
    })
    .await
    .map_err(|_| "Falha ao consultar contas OAuth".to_string())?
}

async fn exchange(
    db: DbConnection,
    client: Client,
    code: String,
    redirect: String,
    verifier: String,
    name: String,
) -> Result<Account, String> {
    let http = http()?;
    let data = body(
        http.post(TOKEN_URL)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client.client_id.as_str()),
                ("client_secret", client.client_secret.as_str()),
                ("code", code.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "Falha na conexão OAuth")?,
    )
    .await?;
    let access = data["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Resposta sem access token")?
        .to_string();
    let identity = body(
        http.get(INFO_URL)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|_| "Falha ao verificar identidade")?,
    )
    .await?;
    let subject = identity["sub"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Identidade Google ausente")?
        .to_string();
    let email = identity["email"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("E-mail Google ausente")?
        .to_string();
    if identity["email_verified"] != true {
        return Err("O e-mail Google não está verificado".into());
    }
    tokio::task::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e|e.to_string())?;
        let tx = conn.transaction().map_err(|e|e.to_string())?;
        let id = tx.query_row("SELECT id FROM antigravity_oauth_accounts WHERE subject=?1", [&subject], |r|r.get::<_,String>(0))
            .optional().map_err(|e|e.to_string())?.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
        let previous = load::<Grant>(&id).ok();
        let refresh = data["refresh_token"].as_str().filter(|s|!s.is_empty()).map(str::to_string)
            .or_else(||previous.as_ref().filter(|g|g.client_id == client.client_id).map(|g|g.refresh_token.clone()))
            .ok_or("O Google não concedeu acesso offline. Reconecte com consentimento.")?;
        save(&id, &Grant { access_token:access, refresh_token:refresh,
            expires_at:crate::util::now_ts()+data["expires_in"].as_i64().filter(|n| *n>0 && *n<=86400).unwrap_or(3600),
            client_id:client.client_id })?;
        let persisted = (|| {
        tx.execute("INSERT INTO antigravity_oauth_accounts(id,subject,name,email,created_at) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(subject) DO UPDATE SET name=excluded.name,email=excluded.email",
            rusqlite::params![id,subject,name,email,crate::util::now_ts()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())
        })();
        if persisted.is_err() {
            let restored = match previous { Some(grant) => save(&id,&grant), None => vault(&id)?.delete_credential().map_err(|_| "Falha ao remover credenciais incompletas".into()) };
            restored?;
            return Err("Não foi possível guardar a conta OAuth".into());
        }
        Ok(Account { id, name, email, connected:true })
    }).await.map_err(|_| "Falha ao guardar conta OAuth".to_string())?
}
use rusqlite::OptionalExtension;

#[tauri::command]
pub async fn antigravity_oauth_start(name: String, app: AppHandle) -> Result<Login, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 100 || name.chars().any(char::is_control) {
        return Err("Informe um nome de conta válido".into());
    }
    let client = tokio::task::spawn_blocking(|| load::<Client>(CLIENT))
        .await
        .map_err(|_| "Cliente OAuth indisponível")??;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Não foi possível abrir o callback local")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Callback indisponível")?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/oauth/callback");
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let state = uuid::Uuid::new_v4().to_string();
    let flow_id = uuid::Uuid::new_v4().to_string();
    let authorization_url = authorization(&client.client_id, &redirect, &state, &verifier);
    let db = app.state::<DbConnection>().inner().clone();
    let flow_key = flow_id.clone();
    // Start gate prevents a fast callback from racing insertion into FLOWS.
    let (ready, start) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = start.await;
        let outcome = tokio::time::timeout(FLOW_TTL, async {
            loop {
                let (mut socket,_) = listener.accept().await.map_err(|_| "Callback OAuth indisponível".to_string())?;
                let request = tokio::time::timeout(Duration::from_secs(5), async {
                    let mut bytes=Vec::new();let mut buffer=[0u8;1024];
                    while !bytes.windows(4).any(|w|w==b"\r\n\r\n") {
                        let n=socket.read(&mut buffer).await.map_err(|_|"Callback inválido")?;
                        if n==0 || bytes.len()+n>8192 { return Err("Callback inválido"); }
                        bytes.extend_from_slice(&buffer[..n]);
                    }
                    String::from_utf8(bytes).map_err(|_|"Callback inválido")
                }).await;
                let parsed = request.ok().and_then(Result::ok).map(|r|callback(&r,port,&state));
                let denied = matches!(&parsed, Some(Err(message)) if message == "O consentimento OAuth foi recusado");
                let code = parsed.and_then(Result::ok);
                let response = if code.is_some() { "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nAutorizacao recebida. Confira o resultado na ADE." }
                    else { "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nCallback invalido." };
                let _=socket.write_all(response.as_bytes()).await;
                let _=socket.shutdown().await;
                if denied { return Err("O consentimento OAuth foi recusado".into()); }
                if let Some(code)=code { return exchange(db,client,code,redirect,verifier,name).await; }
            }
        }).await.unwrap_or_else(|_|Err("O login OAuth expirou".into()));
        if let Ok(mut flows) = FLOWS.lock()
            && let Some(flow) = flows.get_mut(&flow_key)
        {
            flow.progress = match outcome {
                Ok(account) => Progress::Connected { account },
                Err(message) => Progress::Failed { message },
            };
        }
    });
    let mut flows = FLOWS.lock().map_err(|_| "Fluxos OAuth indisponíveis")?;
    flows.retain(|_, flow| {
        if flow.expires < Instant::now() {
            flow.abort.abort();
            false
        } else {
            true
        }
    });
    if flows.len() >= 8 {
        task.abort();
        return Err("Finalize os logins OAuth em andamento".into());
    }
    flows.insert(
        flow_id.clone(),
        Flow {
            progress: Progress::Pending,
            expires: Instant::now() + FLOW_TTL,
            abort: task.abort_handle(),
        },
    );
    let _ = ready.send(());
    Ok(Login {
        flow_id,
        authorization_url,
    })
}
#[tauri::command]
pub fn antigravity_oauth_poll(flow_id: String) -> Result<Progress, String> {
    let mut flows = FLOWS.lock().map_err(|_| "Fluxos OAuth indisponíveis")?;
    let flow = flows.get(&flow_id).ok_or("Login OAuth inexistente")?;
    if flow.expires < Instant::now() {
        if let Some(expired) = flows.remove(&flow_id) {
            expired.abort.abort();
        }
        return Ok(Progress::Failed {
            message: "O login OAuth expirou".into(),
        });
    }
    let progress = flow.progress.clone();
    if !matches!(progress, Progress::Pending) {
        flows.remove(&flow_id);
    }
    Ok(progress)
}
#[tauri::command]
pub fn antigravity_oauth_cancel(flow_id: String) {
    if let Ok(mut flows) = FLOWS.lock()
        && let Some(flow) = flows.remove(&flow_id)
    {
        flow.abort.abort();
    }
}

/// Validates Google identity only, not Cloud Code model entitlement.
#[tauri::command]
pub async fn antigravity_oauth_verify(account_id: String, app: AppHandle) -> Result<(), String> {
    let db = app.state::<DbConnection>().inner().clone();
    let owned = account_id.clone();
    let subject = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT subject FROM antigravity_oauth_accounts WHERE id=?1",
            [&owned],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "Conta OAuth inexistente".to_string())
    })
    .await
    .map_err(|_| "Falha ao consultar conta")??;
    let grant = refreshed_grant(&account_id).await?;
    let identity = body(
        http()?
            .get(INFO_URL)
            .bearer_auth(&grant.access_token)
            .send()
            .await
            .map_err(|_| "Falha ao verificar identidade")?,
    )
    .await?;
    if identity["sub"].as_str() != Some(&subject) || identity["email_verified"] != true {
        return Err("A identidade desta conta mudou. Reconecte a conta.".into());
    }
    Ok(())
}

/// The direct account executor must call this, never fall back to the agy system login.
pub(crate) async fn refreshed_grant(id: &str) -> Result<Grant, String> {
    let lock = REFRESH_LOCKS
        .lock()
        .map_err(|_| "Renovação indisponível")?
        .entry(id.into())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let _guard = lock.lock().await;
    let owned = id.to_string();
    let mut grant = tokio::task::spawn_blocking(move || load::<Grant>(&owned))
        .await
        .map_err(|_| "Conta OAuth indisponível")??;
    let client = tokio::task::spawn_blocking(|| load::<Client>(CLIENT))
        .await
        .map_err(|_| "Cliente OAuth indisponível")??;
    if client.client_id != grant.client_id {
        return Err("O cliente OAuth mudou. Reconecte esta conta.".into());
    }
    if grant.expires_at > crate::util::now_ts() + 60 {
        return Ok(grant);
    }
    let response = http()?
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", grant.refresh_token.as_str()),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "Falha na renovação OAuth")?;
    let data = body(response).await?;
    grant.access_token = data["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Renovação OAuth incompleta")?
        .into();
    if let Some(refresh) = data["refresh_token"].as_str().filter(|s| !s.is_empty()) {
        grant.refresh_token = refresh.into();
    }
    grant.expires_at = crate::util::now_ts()
        + data["expires_in"]
            .as_i64()
            .filter(|n| *n > 0 && *n <= 86400)
            .unwrap_or(3600);
    let result = grant.clone();
    let owned = id.to_string();
    tokio::task::spawn_blocking(move || save(&owned, &grant))
        .await
        .map_err(|_| "Falha ao guardar renovação OAuth")??;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_matches_rfc7636() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn callback_rejects_wrong_state_duplicates_methods_and_routes() {
        assert_eq!(
            callback(
                "GET /oauth/callback?state=expected&code=abc HTTP/1.1\r\n\r\n",
                1234,
                "expected"
            )
            .unwrap(),
            "abc"
        );
        for target in [
            "/oauth/callback?state=wrong&code=abc",
            "/oauth/callback?state=expected&state=expected&code=abc",
            "/oauth/callback?state=expected&code=a&code=b",
            "/other?state=expected&code=a",
            "/oauth/callback?state=expected&error=access_denied",
        ] {
            assert!(callback(&format!("GET {target} HTTP/1.1"), 1234, "expected").is_err());
        }
        assert!(
            callback(
                "POST /oauth/callback?state=expected&code=a HTTP/1.1",
                1234,
                "expected"
            )
            .is_err()
        );
    }
    #[test]
    fn login_uses_own_client_pkce_offline_consent_and_account_selection() {
        let url = url::Url::parse(&authorization(
            "ade.apps.googleusercontent.com",
            "http://127.0.0.1:1234/oauth/callback",
            "csrf",
            "verifier",
        ))
        .unwrap();
        let q: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(
            q.get("client_id").unwrap(),
            "ade.apps.googleusercontent.com"
        );
        assert_eq!(q.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(q.get("access_type").unwrap(), "offline");
        assert_eq!(q.get("prompt").unwrap(), "consent select_account");
        assert!(!q.contains_key("client_secret") && !q.contains_key("code_verifier"));
        assert!(!valid_client("bad\n.apps.googleusercontent.com"));
    }
    #[test]
    fn public_progress_never_serializes_grants() {
        let p = Progress::Connected {
            account: Account {
                id: "account-a".into(),
                name: "A".into(),
                email: "a@example.com".into(),
                connected: true,
            },
        };
        let text = serde_json::to_string(&p).unwrap();
        assert!(
            !text.contains("access_token")
                && !text.contains("refresh_token")
                && !text.contains("client_secret")
        );
    }
}
