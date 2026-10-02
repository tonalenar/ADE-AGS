//! Por qué falló una tarea, en lo que importa para decidir qué hacer después.
//!
//! El reintento de siempre (`scheduler::should_retry`) vuelve a lanzar con la MISMA cuenta.
//! Para dos fallos eso no sirve:
//!
//! - **Límite de uso**: la cuenta no tiene ventana; el segundo intento choca igual. Hay que
//!   anotarla como agotada (el ruteo la saltea) y, si la cuenta la eligió el ruteo, pasar la
//!   tarea a otra con cupo.
//! - **Credencial vencida o rechazada**: la cuenta necesita un login, no otro intento. Sale
//!   del ruteo hasta que se la verifique de nuevo.
//!
//! Una cuenta FIJADA (por el usuario, el Squad o la misión) nunca se cambia sola: la tarea
//! falla diciendo por qué, y el usuario decide (ver ROLES_SQUADS.md).
//!
//! La fuente es el texto del error que dejó la CLI (su resultado o la cola de stderr). Las
//! frases son las de las CLIs reales y de las APIs que tienen detrás; ante la duda, `Other`,
//! que conserva el comportamiento de antes.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// La cuenta se quedó sin cupo (5 h, semanal) o el proveedor devolvió 429.
    RateLimited,
    /// La credencial venció, se revocó o nunca hubo login.
    AuthExpired,
    /// Cualquier otra cosa: un error del agente, de la red, del código.
    Other,
}

/// Frases de límite de uso. Claude Code ("Claude AI usage limit reached", "5-hour limit
/// reached", "You've hit your limit"), Codex ("You've hit your usage limit", "429 Too Many
/// Requests") y los errores de API (`rate_limit_error`).
const RATE_LIMIT: &[&str] = &[
    "usage limit",
    "rate limit",
    "rate_limit",
    "ratelimit",
    "hit your limit",
    "5-hour limit",
    "weekly limit",
    "too many requests",
    "quota exceeded",
    "insufficient_quota",
    "exceeded your current quota",
];

/// Frases de credencial. Claude Code ("Invalid API key · Please run /login", "OAuth token has
/// expired"), Codex ("Not logged in", "access token could not be refreshed", "401
/// Unauthorized") y los errores de API (`authentication_error`, `invalid_api_key`).
const AUTH: &[&str] = &[
    "authentication_error",
    "invalid api key",
    "invalid_api_key",
    "invalid x-api-key",
    "please run /login",
    "not logged in",
    "token has expired",
    "token expired",
    "could not be refreshed",
    "unauthorized",
    // Sin saldo en una cuenta de API: como una credencial, no se arregla reintentando.
    "credit balance is too low",
];

lazy_static::lazy_static! {
    /// Los códigos HTTP solo con algo que diga que son un estado ("status 429", "HTTP 401",
    /// "code: 429"): suelto, `401` aparece en `main.rs:401:5` y `429` en cualquier conteo.
    /// "401 Unauthorized" y "429 Too Many Requests" ya los cubren las frases.
    static ref HTTP_429: regex::Regex = regex::Regex::new(r"(status|http|code)[^a-z0-9]{0,3}429\b").unwrap();
    static ref HTTP_401: regex::Regex = regex::Regex::new(r"(status|http|code)[^a-z0-9]{0,3}401\b").unwrap();
}

pub fn classify(error: &str) -> FailureKind {
    let text = error.to_lowercase();
    // Límite antes que credencial: un 429 que menciona el token ("rate limit for this
    // token") es un límite, no un login vencido.
    if RATE_LIMIT.iter().any(|p| text.contains(p)) || HTTP_429.is_match(&text) {
        FailureKind::RateLimited
    } else if AUTH.iter().any(|p| text.contains(p)) || HTTP_401.is_match(&text) {
        FailureKind::AuthExpired
    } else {
        FailureKind::Other
    }
}

/// Una credencial que falló hace poco: la cuenta queda fuera del ruteo hasta que alguien la
/// verifique (ver `accounts::account_health`) o hasta que pase este plazo — un login rehecho
/// por fuera de la app no avisa, y sin techo la cuenta quedaría afuera para siempre.
pub const AUTH_FAILURE_TTL_SECS: i64 = 6 * 3600;

fn auth_key(account_key: &str) -> String {
    format!("runs.auth_failed.{account_key}")
}

pub fn record_auth_failure(db: &crate::database::DbConnection, account_key: &str, now: i64) {
    let _ = crate::database::set_setting(db, &auth_key(account_key), &now.to_string());
}

pub fn clear_auth_failure(db: &crate::database::DbConnection, account_key: &str) {
    if let Ok(conn) = db.lock() {
        let _ = conn.execute("DELETE FROM settings WHERE key = ?1", [auth_key(account_key)]);
    }
}

/// Si la cuenta tuvo un fallo de credencial reciente, sobre una conexión ya tomada.
pub fn auth_failed_recently(conn: &rusqlite::Connection, account_key: &str, now: i64) -> bool {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [auth_key(account_key)], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .is_some_and(|at| now - at < AUTH_FAILURE_TTL_SECS)
}
