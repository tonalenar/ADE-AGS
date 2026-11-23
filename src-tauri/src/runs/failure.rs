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
    /// The requested model is absent or forbidden for this account.
    ModelUnavailable,
    /// Billing/credits/subscription must be replenished.
    InsufficientBalance,
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
    "quota_exceeded",
    "exceeded your current quota",
    "resource_exhausted",
    "exhausted your capacity",
    "capacity exhausted",
    "capacity_exhausted",
    "individual quota reached",
    "upgrade your subscription to increase your limits",
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
];

lazy_static::lazy_static! {
    /// Los códigos HTTP solo con algo que diga que son un estado ("status 429", "HTTP 401",
    /// "code: 429"): suelto, `401` aparece en `main.rs:401:5` y `429` en cualquier conteo.
    /// Cota esgotada em frases soltas do Antigravity/Gemini e similares («Individual quota reached.», «quota has been
    /// reached, please upgrade»): `reached`/`exhausted` só conta quando fecha a frase ou vem com contexto de conta/plano,
    /// para não pegar «quota reached the 10 file limit of the cache» de um log de código.
    static ref QUOTA_REACHED: regex::Regex = regex::Regex::new(
        r"\bquota\s+(?:has\s+been\s+)?(?:reached|exhausted)\s*(?:$|[.!,:;·|)\-—]|for\s+(?:this|your|the)\s+(?:account|plan|user|model|subscription)\b|please\b|resets?\b|upgrade\b)"
    ).unwrap();
    /// «Daily limit reached, resets in 2 hours», «Message limit reached. Resets at 18:00»: limite atingido com a
    /// renovação anunciada logo depois.
    static ref LIMIT_REACHED_RESETS: regex::Regex = regex::Regex::new(
        r"\blimits?\s+reached\b[^\n]{0,120}?\bresets?\s+(?:in|at)\b"
    ).unwrap();
    /// "401 Unauthorized" y "429 Too Many Requests" ya los cubren las frases.
    static ref HTTP_429: regex::Regex = regex::Regex::new(r"(status|http|code)[^a-z0-9]{0,3}429\b").unwrap();
    static ref HTTP_402: regex::Regex = regex::Regex::new(r"(status|http|code)[^a-z0-9]{0,3}402\b").unwrap();
    static ref HTTP_403: regex::Regex = regex::Regex::new(r"(status|http|code)[^a-z0-9]{0,3}403\b").unwrap();
    static ref HTTP_401: regex::Regex = regex::Regex::new(r"(status|http|code)[^a-z0-9]{0,3}401\b").unwrap();

    /// Timestamp ISO-8601 / RFC 3339 após contexto explícito de renovação ou retry (evita casar timestamps de log).
    static ref ISO_RESET: regex::Regex = regex::Regex::new(
        r#"(?i)\b(?:resets?|reset_?time|resets?_?at|retry[-_ ]?after|try\s+again(?:\s+(?:at|after))?|until|available(?:\s+at)?)(?:\s+(?:at|after|on))?[\s:=("']*(\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:?\d{2}))"#
    ).unwrap();

    /// Gatilhos explícitos de espera relativa («try again in 42 minutes», «retry after 2h», «Please retry in 37s», «Retry-After: 120»).
    static ref RELATIVE_EXPLICIT: regex::Regex = regex::Regex::new(
        r#"(?i)\b(?:(?:try\s+again|please\s+retry|retry|resets?|available(?:\s+again)?|back)\s+(?:in|after)\s+|wait\s+|retry[-_ ]?delay\s*[:=]\s*["']?|retry[-_ ]?after\s*[:=]\s*["']?)"#
    ).unwrap();

    /// Gatilho genérico «in <duração>» (filtrado contra verbos de conclusão/passado como «completed in 3s»).
    static ref RELATIVE_IN: regex::Regex = regex::Regex::new(r"(?i)\bin\s+").unwrap();
}

const MODEL_ACCESS: &[&str] = &[
    "model_not_found", "model not found", "unknown model", "invalid model", "unsupported model",
    "model is not available", "model is not supported", "does not exist or you do not have access",
    "do not have access to model", "do not have access to the model",
];
const BALANCE: &[&str] = &[
    "credit balance is too low", "insufficient credits", "insufficient balance", "out of credits",
    "insufficient_quota", "payment required", "subscription required", "subscription has expired",
];

impl FailureKind {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::RateLimited => "rate_limited", Self::AuthExpired => "auth",
            Self::ModelUnavailable => "model", Self::InsufficientBalance => "balance", Self::Other => "other",
        }
    }
}

pub fn classify(error: &str) -> FailureKind {
    let text = error.to_lowercase();
    // Límite antes que credencial: un 429 que menciona el token ("rate limit for this
    // token") es un límite, no un login vencido.
    if BALANCE.iter().any(|p| text.contains(p)) || HTTP_402.is_match(&text) {
        FailureKind::InsufficientBalance
    } else if MODEL_ACCESS.iter().any(|p| text.contains(p))
        || (text.contains("model") && ["not supported when using", "does not exist", "not found", "access to this model"].iter().any(|p| text.contains(p))) {
        FailureKind::ModelUnavailable
    } else if RATE_LIMIT.iter().any(|p| text.contains(p)) || HTTP_429.is_match(&text) || QUOTA_REACHED.is_match(&text) || LIMIT_REACHED_RESETS.is_match(&text) {
        FailureKind::RateLimited
    } else if AUTH.iter().any(|p| text.contains(p)) || HTTP_401.is_match(&text) || HTTP_403.is_match(&text) {
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

/// Limite máximo aceito para durações relativas (35 dias: cobre janelas de segundos a mensais).
const MAX_RELATIVE_SECS: i64 = 35 * 86_400;

/// Extrai o instante (epoch em segundos) de renovação de cota mencionado no texto de um erro.
///
/// Formatos suportados (em ordem de precisão):
/// 1. ISO-8601 / RFC 3339 após contexto de reset/retry (`resets at 2026-11-22T18:00:00Z`, com offset `-03:00` etc.),
///    aceito apenas quando está no futuro (`ts > now`).
/// 2. Relógio após `resets` (opcionalmente `resets at`): 12 h (`1:10pm`, `3pm`, `12am`) ou 24 h (`18:00`, `23:59:30`),
///    com fuso opcional entre parênteses ou logo após a hora.
///    - Fusos `UTC`, `GMT`, `Etc/UTC`, `Etc/GMT` e offsets explícitos (`±HH:MM`, `UTC±H`, `GMT±HH:MM`) são resolvidos
///      exatamente sem depender do fuso da máquina.
///    - Nomes IANA (ex.: `(America/Sao_Paulo)`, `(America/Los_Angeles)`) não têm base tzdb no `Cargo.toml`, portanto
///      preservam o comportamento anterior usando `local_offset_secs`.
/// 3. Duração relativa (`try again in 42 minutes`, `retry after 2h`, `in 1 hour 30 minutes`, `Please retry in 37s`,
///    `Retry-After: 120`, `retryDelay: 45s`).
///
/// Retorna `None` quando nenhum formato válido casa (quem chama decide se aplica fallback).
pub fn parse_reset_at(text: &str, now: i64, local_offset_secs: i64) -> Option<i64> {
    parse_iso_reset(text, now)
        .or_else(|| parse_clock_after_resets(text, now, local_offset_secs))
        .or_else(|| parse_relative_reset(text, now))
}

fn parse_iso_reset(text: &str, now: i64) -> Option<i64> {
    for caps in ISO_RESET.captures_iter(text) {
        let Some(raw) = caps.get(1).map(|m| m.as_str()) else { continue };
        let normalized = normalize_rfc3339(raw);
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&normalized) {
            let ts = dt.timestamp();
            if ts > now {
                return Some(ts);
            }
        }
    }
    None
}

fn normalize_rfc3339(raw: &str) -> String {
    let mut s = raw.replace(['t', ' '], "T").replace('z', "Z");
    let bytes = s.as_bytes();
    // Converte sufixo ±HHMM para ±HH:MM aceito por `parse_from_rfc3339`.
    if bytes.len() >= 5 {
        let tail = &bytes[bytes.len() - 5..];
        if matches!(tail[0], b'+' | b'-') && tail[1..].iter().all(u8::is_ascii_digit) {
            let split = s.len() - 2;
            s.insert(split, ':');
        }
    }
    s
}

fn parse_clock_after_resets(text: &str, now: i64, local_offset_secs: i64) -> Option<i64> {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("resets") {
        let pos = from + rel;
        from = pos + "resets".len();
        // Fronteira de palavra antes (rejeita «presets 3pm») e espaço depois (rejeita «resetsAt»).
        if pos > 0 && (bytes[pos - 1].is_ascii_alphanumeric() || bytes[pos - 1] == b'_') {
            continue;
        }
        let after_kw = &lower[from..];
        if !after_kw.starts_with(|c: char| c.is_ascii_whitespace()) {
            continue;
        }
        let mut rest = after_kw.trim_start_matches([' ', '\t']);
        if let Some(after_at) = rest.strip_prefix("at")
            && after_at.starts_with([' ', '\t'])
        {
            rest = after_at.trim_start_matches([' ', '\t']);
        }
        let Some((hour24, minute, second, tz_offset)) = parse_clock_and_tz(rest) else {
            continue;
        };
        let tz = tz_offset.unwrap_or(local_offset_secs);
        let local_now = now + tz;
        let day_start = local_now - local_now.rem_euclid(86_400);
        let mut target = day_start + hour24 * 3600 + minute * 60 + second;
        if target <= local_now {
            target += 86_400;
        }
        return Some(target - tz);
    }
    None
}

/// Lê hora 12 h (`1:10pm`, `3pm`, `12am`) ou 24 h (`18:00`, `23:59:30`) e fuso opcional (`(UTC)`, `(+02:00)`, `UTC`).
fn parse_clock_and_tz(rest: &str) -> Option<(i64, i64, i64, Option<i64>)> {
    let h_len = rest.bytes().take_while(u8::is_ascii_digit).count();
    if h_len == 0 || h_len > 2 {
        return None;
    }
    let hour: i64 = rest[..h_len].parse().ok()?;
    let mut after = &rest[h_len..];
    let mut has_colon = false;
    let mut minute = 0i64;
    let mut second = 0i64;

    if let Some(m) = after.strip_prefix(':') {
        let m_len = m.bytes().take_while(u8::is_ascii_digit).count();
        if m_len != 2 {
            return None;
        }
        minute = m[..2].parse().ok()?;
        has_colon = true;
        after = &m[2..];
        if let Some(s) = after.strip_prefix(':') {
            let s_len = s.bytes().take_while(u8::is_ascii_digit).count();
            if s_len != 2 {
                return None;
            }
            second = s[..2].parse().ok()?;
            after = &s[2..];
        }
    }

    if minute > 59 || second > 59 {
        return None;
    }

    let trimmed = after.trim_start_matches([' ', '\t']);
    let mer = trimmed.get(..2).filter(|m| *m == "am" || *m == "pm").filter(|_| {
        trimmed.as_bytes().get(2).is_none_or(|b| !b.is_ascii_alphabetic())
    });

    let (hour24, tz_tail) = if let Some(m) = mer {
        if !(1..=12).contains(&hour) {
            return None;
        }
        let pm = m == "pm";
        ((hour % 12) + if pm { 12 } else { 0 }, &trimmed[2..])
    } else if has_colon {
        // Rejeita letras coladas ao relógio 24h (ex.: «18:00x»), exceto sufixo «z» isolado (UTC).
        if let Some(first) = after.as_bytes().first()
            && first.is_ascii_alphabetic()
        {
            let is_utc_z = *first == b'z' && after.as_bytes().get(1).is_none_or(|b| !b.is_ascii_alphabetic());
            if !is_utc_z {
                return None;
            }
        }
        if hour > 23 {
            return None;
        }
        (hour, after)
    } else {
        return None;
    };

    let tz_offset = extract_trailing_tz(tz_tail);
    Some((hour24, minute, second, tz_offset))
}

fn extract_trailing_tz(tail: &str) -> Option<i64> {
    if let Some(rest) = tail.strip_prefix('z')
        && rest.as_bytes().first().is_none_or(|b| !b.is_ascii_alphabetic())
    {
        return Some(0);
    }
    let trimmed = tail.trim_start_matches([' ', '\t']);
    if let Some(after_open) = trimmed.strip_prefix('(')
        && let Some(close) = after_open.find(')')
    {
        return parse_tz_offset(&after_open[..close]);
    }
    if trimmed.starts_with("utc") || trimmed.starts_with("gmt") {
        let len = trimmed
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b':' | b'/'))
            .count();
        return parse_tz_offset(&trimmed[..len]);
    }
    None
}

/// Converte fuso explícito (`UTC`, `GMT`, `Z`, `Etc/UTC`, `UTC+02:00`, `GMT-3`, `+05:30`, `-0300`) em segundos.
/// Nomes IANA (ex.: `America/Sao_Paulo`) retornam `None` por não haver base tzdb no crate.
fn parse_tz_offset(raw: &str) -> Option<i64> {
    let tz = raw.trim().to_ascii_uppercase();
    match tz.as_str() {
        "UTC" | "GMT" | "Z" | "ETC/UTC" | "ETC/GMT" | "ETC/GMT+0" | "ETC/GMT-0" => return Some(0),
        _ => {}
    }
    if let Some(rest) = tz.strip_prefix("UTC").or_else(|| tz.strip_prefix("GMT")) {
        return parse_signed_offset(rest.trim());
    }
    if tz.starts_with('+') || tz.starts_with('-') {
        return parse_signed_offset(&tz);
    }
    None
}

fn parse_signed_offset(s: &str) -> Option<i64> {
    let (sign, rest) = if let Some(r) = s.strip_prefix('+') {
        (1i64, r)
    } else if let Some(r) = s.strip_prefix('-') {
        (-1i64, r)
    } else {
        return None;
    };
    let (hours, mins) = if let Some((h, m)) = rest.split_once(':') {
        if h.is_empty() || h.len() > 2 || m.len() != 2 || !h.bytes().all(|b| b.is_ascii_digit()) || !m.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?)
    } else if rest.len() == 4 && rest.bytes().all(|b| b.is_ascii_digit()) {
        (rest[..2].parse::<i64>().ok()?, rest[2..].parse::<i64>().ok()?)
    } else if (1..=2).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_digit()) {
        (rest.parse::<i64>().ok()?, 0i64)
    } else {
        return None;
    };
    if hours > 14 || mins > 59 || (hours == 14 && mins > 0) {
        return None;
    }
    Some(sign * (hours * 3600 + mins * 60))
}

fn parse_relative_reset(text: &str, now: i64) -> Option<i64> {
    for m in RELATIVE_EXPLICIT.find_iter(text) {
        let rest = &text[m.end()..];
        if let Some(secs) = parse_duration_secs(rest) {
            return Some(now + secs);
        }
        // Header HTTP `Retry-After: 120` (número inteiro em segundos, sem unidade inválida colada).
        let matched = m.as_str().to_ascii_lowercase();
        if matched.contains("retry") && matched.contains("after") && (matched.contains(':') || matched.contains('=')) {
            if let Some(secs) = parse_bare_seconds(rest) {
                return Some(now + secs);
            }
        }
    }

    const EXCLUDED_PREV_WORDS: &[&str] = &[
        "completed", "finished", "done", "failed", "ran", "took", "elapsed",
        "built", "compiled", "responded", "loaded", "executed", "timeout",
        "timed", "out", "last", "past", "every", "for",
    ];
    for m in RELATIVE_IN.find_iter(text) {
        let prev = previous_ascii_word(&text[..m.start()]);
        if prev.is_some_and(|w| EXCLUDED_PREV_WORDS.contains(&w.as_str())) {
            continue;
        }
        if let Some(secs) = parse_duration_secs(&text[m.end()..]) {
            return Some(now + secs);
        }
    }
    None
}

fn previous_ascii_word(prefix: &str) -> Option<String> {
    let trimmed = prefix.trim_end_matches([' ', '\t']);
    let bytes = trimmed.as_bytes();
    let end = bytes.len();
    let mut start = end;
    while start > 0 && bytes[start - 1].is_ascii_alphabetic() {
        start -= 1;
    }
    (start < end).then(|| trimmed[start..end].to_ascii_lowercase())
}

fn parse_bare_seconds(rest: &str) -> Option<i64> {
    let d_len = rest.bytes().take_while(u8::is_ascii_digit).count();
    if d_len == 0 || d_len > 7 {
        return None;
    }
    if rest.as_bytes().get(d_len).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let secs: i64 = rest[..d_len].parse().ok()?;
    (1..=MAX_RELATIVE_SECS).contains(&secs).then_some(secs)
}

/// Lê uma ou mais unidades compostas de tempo (`42 minutes`, `2h`, `1 hour 30 minutes`, `37.4s`, `1h 15m 20s`).
fn parse_duration_secs(input: &str) -> Option<i64> {
    let mut rest = input;
    let mut total = 0.0f64;
    let mut seen_mask = 0u8;
    let mut count = 0usize;

    loop {
        if count > 0 {
            let trimmed = rest.trim_start_matches([' ', '\t', ',']);
            if let Some(after_and) = trimmed
                .strip_prefix("and")
                .or_else(|| trimmed.strip_prefix("AND"))
                .filter(|r| r.starts_with([' ', '\t']))
            {
                rest = after_and.trim_start_matches([' ', '\t']);
            } else {
                rest = trimmed;
            }
        }

        let int_len = rest.bytes().take_while(u8::is_ascii_digit).count();
        if int_len == 0 || int_len > 7 {
            break;
        }
        let mut num_len = int_len;
        if rest.as_bytes().get(num_len) == Some(&b'.') {
            let frac_len = rest[num_len + 1..].bytes().take_while(u8::is_ascii_digit).count();
            if frac_len == 0 || frac_len > 6 {
                break;
            }
            num_len += 1 + frac_len;
        }
        let Ok(value) = rest[..num_len].parse::<f64>() else { break };
        if !value.is_finite() || value < 0.0 {
            break;
        }

        let after_num = rest[num_len..].trim_start_matches([' ', '\t']);
        let unit_len = after_num.bytes().take_while(u8::is_ascii_alphabetic).count();
        if unit_len == 0 {
            break;
        }
        let unit = after_num[..unit_len].to_ascii_lowercase();
        let (mult, bit) = match unit.as_str() {
            "d" | "day" | "days" => (86_400.0, 1u8),
            "h" | "hr" | "hrs" | "hour" | "hours" => (3_600.0, 2u8),
            "m" | "min" | "mins" | "minute" | "minutes" => (60.0, 4u8),
            "s" | "sec" | "secs" | "second" | "seconds" => (1.0, 8u8),
            _ => break,
        };
        if (seen_mask & bit) != 0 {
            break;
        }
        seen_mask |= bit;
        total += value * mult;
        count += 1;
        rest = &after_num[unit_len..];
    }

    if count == 0 {
        return None;
    }
    let secs = total.ceil() as i64;
    (1..=MAX_RELATIVE_SECS).contains(&secs).then_some(secs)
}
