//! El consumo del PLAN, preguntado a la propia TUI.
//!
//! El porcentaje de cupo no está en ningún archivo: Claude Code se lo pide a la API cuando
//! corrés `/usage` y no lo guarda. Pero `/usage` lo resuelve el CLIENTE, no el modelo —
//! así que se le puede preguntar sin gastar tokens y sin adivinar ningún endpoint interno:
//! se abre `claude` en una PTY (algo que esta app ya hace para cada tab), se le manda el
//! comando y se lee lo que dibuja.
//!
//! Es lectura de pantalla, con lo que eso implica: si cambia el formato de ese panel, el
//! parseo deja de encontrar los números. Por eso devuelve `available: false` en vez de
//! ceros, y por eso el parser vive separado y con los tests hechos sobre una captura real.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, watch};

use crate::accounts::AccountKind;
use crate::database::DbConnection;
use crate::terminal::containment::ProcessGroup;
use serde::{Deserialize, Serialize};

use super::parse::parse_usage_screen_with_notice;
use super::trust::{config_file, probe_dir, trust_dir};

/// Tempo máximo esperando o painel terminar sob carga (ex.: Mac ocupado).
const TIMEOUT: Duration = Duration::from_secs(45);

/// Tempo mínimo antes de checar prontidão da TUI; evita mandar `/usage` antes da inicialização.
const MIN_SETTLE: Duration = Duration::from_millis(800);

/// Limite máximo esperando o prompt inicial antes de enviar `/usage`.
const MAX_SETTLE: Duration = Duration::from_secs(8);

/// Cuánto tiene que estar quieta la salida para dar el panel por terminado.
///
/// El panel NO llega de una: primero pinta la ventana y la semana, y un momento después
/// repinta con la semana por modelo (mientras tanto dice «Refreshing…»). Cortar en la
/// primera pintada —que es lo que se hacía— dejaba afuera esa barra.
const QUIET: Duration = Duration::from_millis(700);

/// Espera extra quando a tela ainda indica "Loading usage" ou "Refreshing…".
const QUIET_LOADING: Duration = Duration::from_millis(3000);

/// Validade padrão de uma leitura em cache (5 min).
pub(super) const USAGE_TTL_SECS: i64 = 5 * 60;

#[derive(Debug, Clone, Default)]
pub(super) struct BackoffState {
    pub failures: u32,
    pub until: i64,
    pub problem: String,
}

type InFlightMap = AsyncMutex<HashMap<String, watch::Receiver<Option<LiveUsage>>>>;

/// Estado compartilhado (ou isolado em testes) de cache, backoff exponencial e single-flight.
pub(super) struct ClaudeUsageState {
    pub cache: Mutex<HashMap<String, LiveUsage>>,
    pub backoff: Mutex<HashMap<String, BackoffState>>,
    pub in_flight: InFlightMap,
    pub probe_semaphore: Semaphore,
}

impl Default for ClaudeUsageState {
    fn default() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
            in_flight: AsyncMutex::new(HashMap::new()),
            probe_semaphore: Semaphore::new(1),
        }
    }
}

static GLOBAL_STATE: LazyLock<Arc<ClaudeUsageState>> =
    LazyLock::new(|| Arc::new(ClaudeUsageState::default()));

/// Dónde se guarda, para que al abrir la app el panel muestre lo último sabido en vez de
/// una barra vacía mientras se levanta la TUI.
///
/// La `v2` no es decorativa: lo guardado por la versión anterior se leyó con el parseo que
/// confundía la semana con la barra de un modelo. Cambiar la clave lo deja atrás en vez de
/// mostrar ese número hasta que se refresque.
fn stored_key(account_key: &str) -> String {
    format!("usage.live.v2.{account_key}")
}

/// Una de las barras del panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Meter {
    /// Del 0 al 100, tal como lo informa la TUI.
    pub percent: u8,
    /// Cuándo se reinicia, con el texto que muestra la TUI (incluye su zona horaria).
    pub resets: Option<String>,
    /// Epoch em segundos quando a fonte informa timestamp estruturado (`.claude.json` ou `rate_limit_event`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

/// La semana de un modelo concreto, cuando el plan lo mide aparte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeter {
    pub model: String,
    pub meter: Meter,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveUsage {
    /// `false` = no se pudo preguntar (no está instalada, tardó demasiado, pidió confiar
    /// en la carpeta, o cambió el formato del panel).
    pub available: bool,
    /// La ventana corta, la que se reinicia cada pocas horas.
    pub session: Option<Meter>,
    /// La semana, sumando todos los modelos.
    pub week: Option<Meter>,
    /// Las semanas que el plan mide por modelo (Fable, por ejemplo).
    pub week_models: Vec<ModelMeter>,
    /// Cuándo se preguntó de verdad, en epoch de segundos. Es lo que le permite a la UI
    /// decir "actualizado hace tanto" en vez de dar a entender que el dato es de ahora.
    pub fetched_at: i64,
    /// `true` = salió de la caché, no se volvió a preguntar.
    pub cached: bool,
    /// Por qué no se pudo, para poder decirlo en vez de mostrar un panel vacío.
    pub problem: Option<String>,
    /// Epoch em segundos da próxima tentativa automática após backoff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
}

impl LiveUsage {
    fn failed(reason: impl Into<String>) -> Self {
        LiveUsage {
            problem: Some(reason.into()),
            ..Default::default()
        }
    }
}

/// Problemas de autenticação exigem ação explícita e não devem ser mascarados por cache antigo.
fn is_auth_problem(problem: &str) -> bool {
    matches!(problem, "accounts.auth.expired" | "accounts.auth.required")
}

/// Calcula o intervalo de backoff exponencial em segundos de acordo com o tipo de erro.
pub(super) fn backoff_duration_secs(problem: &str, failures: u32) -> i64 {
    let idx = failures.saturating_sub(1) as usize;
    match problem {
        "accounts.plan.problem.rateLimited" => {
            const STEPS: [i64; 4] = [120, 300, 600, 900];
            STEPS[idx.min(STEPS.len() - 1)]
        }
        p if is_auth_problem(p) => 300,
        "accounts.plan.problem.apiKey"
        | "accounts.plan.problem.notInstalled"
        | "accounts.plan.problem.commandUnknown" => 600,
        _ => {
            const STEPS: [i64; 5] = [60, 120, 240, 480, 900];
            STEPS[idx.min(STEPS.len() - 1)]
        }
    }
}

/// Detect login, rate-limit (429), and usage-load failures before timing out.
pub(super) fn capture_problem(raw: &str) -> Option<&'static str> {
    let screen = super::screen::render(raw).to_lowercase();
    if screen.contains("oauth session expired")
        || screen.contains("oauth token expired")
        || screen.contains("token has expired")
    {
        Some("accounts.auth.expired")
    } else if screen.contains("not logged in")
        || screen.contains("please run /login")
        || screen.contains("failed to authenticate")
        || screen.contains("invalid authentication")
        || screen.contains("select login method")
        || screen.contains("sign in to claude")
    {
        Some("accounts.auth.required")
    } else if screen.contains("temporarily limiting requests")
        || screen.contains("usage page is rate limited")
        || screen.contains("rate limited until")
        || screen.contains("requests temporarily limited")
        || screen.contains("rate_limit_error")
        || screen.contains("too many requests")
        || screen.contains("http 429")
    {
        Some("accounts.plan.problem.rateLimited")
    } else if screen.contains("couldn't load usage data")
        || screen.contains("could not load usage data")
        || screen.contains("failed to load usage data")
    {
        Some("accounts.plan.problem.loadFailed")
    } else {
        None
    }
}

/// Aplica o ambiente da conta na sonda PTY, removendo variáveis herdadas de sessão pai e
/// variáveis sobrescritoras (ex.: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), além de
/// limpar `CLAUDE_CONFIG_DIR` herdado quando a sonda é para a conta principal.
pub(super) fn apply_probe_env(cmd: &mut CommandBuilder, env: &[(String, String)]) {
    crate::terminal::scrub_pty_app_child_env(cmd);
    cmd.env_remove("CLAUDECODE");
    if !env.iter().any(|(k, _)| k == "CLAUDE_CONFIG_DIR") {
        cmd.env_remove("CLAUDE_CONFIG_DIR");
    }
    for var in crate::agents::overriding_env(env.iter().map(|(k, _)| k)) {
        cmd.env_remove(var);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
}

fn has_usage_panel(screen: &str) -> bool {
    screen.contains("Current session") || screen.contains("Current week")
}

fn is_still_loading(screen: &str) -> bool {
    screen.contains("Loading usage data")
        || screen.contains("Refreshing usage")
        || screen.contains("Refreshing…")
}

fn prompt_ready(screen: &str) -> bool {
    screen.contains('❯')
        || screen.contains("? for shortcuts")
        || screen.contains("Try \"")
}

/// Abre `claude` en una PTY, le manda `/usage` y devuelve lo que dibujó.
///
/// No es privada para poder probarla contra la TUI instalada (ver `contra_la_tui_de_verdad`).
pub(super) fn capture(
    command: &str,
    cwd: &str,
    env: &[(String, String)],
) -> Result<String, String> {
    match capture_with_flags(command, cwd, env, true) {
        Err(e) if e == "__RETRY_NO_STRICT_MCP__" => capture_with_flags(command, cwd, env, false),
        other => other,
    }
}

fn capture_with_flags(
    command: &str,
    cwd: &str,
    env: &[(String, String)],
    strict_mcp: bool,
) -> Result<String, String> {
    let pty = crate::terminal::open_pty(PtySize {
        rows: super::screen::ROWS as u16,
        cols: super::screen::COLS as u16,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(command);
    if strict_mcp {
        cmd.arg("--strict-mcp-config");
    }
    cmd.cwd(cwd);
    // Sin esto la TUI se dibuja en modo tonto y el panel no sale.
    cmd.env("TERM", "xterm-256color");
    // Limpa marcadores da sessão pai e configura a conta antes de marcar como sessão filha efêmera.
    apply_probe_env(&mut cmd, env);
    // Que esta sesión de sondeo NO deje transcript: si no, cada vez que se mira el
    // consumo aparecería una conversación vacía en el historial del usuario.
    cmd.env("CLAUDE_CODE_CHILD_SESSION", "1");

    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    // `open_pty` en Windows es el ConPTY con `CREATE_NO_WINDOW` (`win_conpty`).
    // El grupo es el de las tabs: al cortar el sondeo mueren el `claude` y los nietos.
    // El `Drop` cubre los `?` de acá abajo.
    let mut probe = UsageProbe::new(child);

    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pty.master.take_writer().map_err(|e| e.to_string())?;

    // El lector va en su propio hilo: `read` bloquea, y hace falta poder rendirse por
    // tiempo aunque la TUI no escriba nada más.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let start = Instant::now();
    let mut raw = Vec::new();
    let mut text = String::new();
    let mut screen = String::new();
    let mut sent_at: Option<Instant> = None;
    let mut retried_enter = false;
    let mut last_data = Instant::now();

    let result = loop {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            raw.extend_from_slice(&chunk);
            text = capture_text(&raw);
            screen = super::screen::render(&text);
            last_data = Instant::now();
        }

        if strict_mcp && screen.to_lowercase().contains("unknown option '--strict-mcp-config'") {
            break Err("__RETRY_NO_STRICT_MCP__".to_string());
        }

        let panel = sent_at.is_some() && has_usage_panel(&screen);
        if let Some(problem) = capture_problem(&text) {
            // Se o erro for de autenticação, ou ainda não apareceu nenhum painel, corta imediatamente.
            // Se o painel já apareceu (ex.: cache do próprio Claude com aviso "rate limited"), deixa terminar de pintar.
            if is_auth_problem(problem) || !panel {
                break Err(problem.to_string());
            }
        }

        // La carpeta no está entre las de confianza y la TUI está esperando una respuesta.
        // No se contesta por el usuario: se corta y se dice.
        // Se mira sin espacios: la TUI arma las columnas moviendo el cursor, así que el
        // texto crudo viene como "Isthisaprojectyoucreated" (con eso el sondeo se quedaba
        // esperando un panel que nunca iba a salir, y el error era un "timeout" mudo).
        let squeezed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if squeezed.contains("Isthisaprojectyoucreated") || squeezed.contains("trustthisfolder") {
            break Err("accounts.plan.problem.trustRequired".to_string());
        }

        if sent_at.is_none() {
            let ready = start.elapsed() >= MIN_SETTLE
                && (prompt_ready(&screen)
                    || (!raw.is_empty() && start.elapsed() >= Duration::from_millis(1200) && last_data.elapsed() >= Duration::from_millis(500))
                    || start.elapsed() >= MAX_SETTLE);
            if ready {
                let _ = writer.write_all(b"/usage");
                let _ = writer.flush();
                // Pequena pausa para o autocomplete/input processar `/usage` antes do Enter.
                std::thread::sleep(Duration::from_millis(150));
                let _ = writer.write_all(b"\r");
                let _ = writer.flush();
                sent_at = Some(Instant::now());
            }
        } else if let Some(at) = sent_at
            && !retried_enter
            && !panel
            && !is_still_loading(&screen)
            && at.elapsed() >= Duration::from_secs(4)
            && screen.contains("/usage")
        {
            let _ = writer.write_all(b"\r");
            let _ = writer.flush();
            retried_enter = true;
        }

        // Se corta cuando el panel ya tiene todo y não está mais em "Loading/Refreshing",
        // ou quando passa o tempo de silêncio adequado.
        let loading = is_still_loading(&screen);
        let quiet_target = if loading { QUIET_LOADING } else { QUIET };
        if panel && ((!loading && complete(&text)) || last_data.elapsed() >= quiet_target) {
            break Ok(text);
        }
        if start.elapsed() > TIMEOUT {
            // Con el panel dibujado se devuelve igual: que el desglose de abajo tarde
            // demasiado no es motivo para tirar los porcentajes que ya están.
            break if panel {
                Ok(text)
            } else if sent_at.is_some() {
                Err("accounts.plan.problem.timeout".to_string())
            } else {
                Err("accounts.plan.problem.startup".to_string())
            };
        }
    };

    // Para cuando cambie el panel de la TUI y el parseo deje de encontrarlo: con
    // `CC_USAGE_DUMP=<archivo>` se guarda lo crudo que se vio, y se prueba después con
    // `CC_USAGE_CAPTURE` (ver `contra_una_captura_cruda_en_disco`).
    if let Ok(path) = std::env::var("CC_USAGE_DUMP") {
        let _ = std::fs::write(path, &raw);
    }

    probe.release();
    result
}

pub(super) fn capture_text(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).into_owned()
}

/// El hijo de `/usage` y todo lo que haya alcanzado a lanzar.
struct UsageProbe {
    group: ProcessGroup,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    released: bool,
}

impl UsageProbe {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        let mut group = ProcessGroup::new(0);
        group.adopt(&*child);
        Self { group, child, released: false }
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        release_usage_process(&mut self.group, &mut *self.child);
    }
}

impl Drop for UsageProbe {
    fn drop(&mut self) {
        self.release();
    }
}

/// Mata el grupo entero y recién después al hijo directo. Es el cierre de `capture`.
pub(super) fn release_usage_process(
    group: &mut ProcessGroup,
    child: &mut (dyn portable_pty::Child + Send + Sync),
) {
    group.kill_all();
    let _ = child.kill();
    let _ = child.wait();
}

/// ¿Ya está todo lo que interesa?
///
/// Las tres barras dibujadas y sin «Refreshing…», que es lo que la TUI muestra mientras le
/// falta una. Con eso se corta al toque; un plan que no mida modelos aparte nunca cumple
/// esto y termina cortando por silencio, que es lo mismo unos cientos de milisegundos
/// después.
fn complete(text: &str) -> bool {
    let screen = super::screen::render(text);
    let lines: Vec<&str> = screen.lines().map(str::trim).collect();
    let has = |label: &str| lines.iter().any(|l| l.starts_with(label));
    let per_model = lines
        .iter()
        .any(|l| l.starts_with("Current week (") && !l.contains("(all models)"));

    has("Current session")
        && has("Current week (all models)")
        && per_model
        && !is_still_loading(&screen)
}

fn parse_rfc3339_or_epoch(value: &serde_json::Value) -> Option<i64> {
    if let Some(secs) = value.as_i64() {
        return Some(secs);
    }
    value
        .as_str()
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.timestamp())
}

fn parse_config_meter(node: &serde_json::Value) -> Option<Meter> {
    let pct = node["utilization"]
        .as_f64()
        .or_else(|| node["percent"].as_f64())
        .filter(|v| v.is_finite() && *v >= 0.0)?;
    let percent = pct.round().clamp(0.0, 100.0) as u8;
    let resets_at = parse_rfc3339_or_epoch(&node["resets_at"]);
    Some(Meter {
        percent,
        resets: None,
        resets_at,
    })
}

/// Lê o snapshot `cachedUsageUtilization` salvo pelo próprio Claude CLI em `.claude.json`
/// (sem abrir PTY, sem rede e sem tocar no Keychain).
pub(super) fn read_claude_config_usage(config_path: &Path, now: i64) -> Option<LiveUsage> {
    let raw = std::fs::read_to_string(config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let cached = json.get("cachedUsageUtilization")?;

    let current_uuid = json
        .pointer("/oauthAccount/accountUuid")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let cached_uuid = cached
        .get("accountUuid")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    if let (Some(expected), Some(actual)) = (current_uuid, cached_uuid)
        && expected != actual
    {
        return None;
    }

    let fetched_at_ms = cached.get("fetchedAtMs").and_then(|v| v.as_i64())?;
    let fetched_at = fetched_at_ms / 1000;
    if fetched_at <= 0 || fetched_at > now + 60 {
        return None;
    }

    let utilization = cached.get("utilization")?;
    let session = parse_config_meter(&utilization["five_hour"]);
    let week = parse_config_meter(&utilization["seven_day"]);
    let mut week_models = Vec::new();
    if let Some(limits) = utilization.get("limits").and_then(|v| v.as_array()) {
        for item in limits {
            if item["kind"].as_str() != Some("weekly_scoped") {
                continue;
            }
            let Some(model) = item
                .pointer("/scope/model/display_name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if let Some(meter) = parse_config_meter(item)
                && !week_models.iter().any(|m: &ModelMeter| m.model == model)
            {
                week_models.push(ModelMeter {
                    model: model.to_string(),
                    meter,
                });
            }
        }
    }
    if week_models.is_empty()
        && let Some(meter) = parse_config_meter(&utilization["seven_day_sonnet"])
    {
        week_models.push(ModelMeter {
            model: "Sonnet".to_string(),
            meter,
        });
    }

    if session.is_none() && week.is_none() && week_models.is_empty() {
        return None;
    }

    Some(LiveUsage {
        available: true,
        session,
        week,
        week_models,
        fetched_at,
        cached: true,
        problem: None,
        retry_at: None,
    })
}

/// Lê os limites recentes capturados passivamente de `rate_limit_event` (`runs::quota`).
pub(super) fn read_quota_fallback(db: &DbConnection, account_key: &str, now: i64) -> Option<LiveUsage> {
    let quota = {
        let conn = db.lock().ok()?;
        crate::runs::quota::load(&conn, account_key)?
    };
    if quota.observed_at <= 0 || quota.observed_at > now + 60 {
        return None;
    }
    let to_meter = |w: &crate::runs::quota::QuotaWindow| Meter {
        percent: (w.utilization * 100.0).round().clamp(0.0, 100.0) as u8,
        resets: None,
        resets_at: w.resets_at,
    };
    let mut session = quota.five_hour.as_ref().map(to_meter);
    if session.is_none() && quota.rejected {
        session = Some(Meter {
            percent: 100,
            resets: None,
            resets_at: quota.rejected_until,
        });
    }
    let week = quota.seven_day.as_ref().map(to_meter);
    if session.is_none() && week.is_none() {
        return None;
    }
    Some(LiveUsage {
        available: true,
        session,
        week,
        week_models: Vec::new(),
        fetched_at: quota.observed_at,
        cached: true,
        problem: None,
        retry_at: None,
    })
}

fn has_usable_bars(usage: &LiveUsage) -> bool {
    usage.available && (usage.session.is_some() || usage.week.is_some() || !usage.week_models.is_empty())
}

fn is_fresh_reading(usage: &LiveUsage, now: i64) -> bool {
    if !has_usable_bars(usage) || usage.problem.is_some() || usage.fetched_at <= 0 {
        return false;
    }
    let age = now - usage.fetched_at;
    if age < 0 || age >= USAGE_TTL_SECS {
        return false;
    }
    // Se a janela curta informada já passou do horário de renovação, precisa reler.
    !usage
        .session
        .as_ref()
        .and_then(|s| s.resets_at)
        .is_some_and(|r| r <= now)
}

fn store_good_snapshot(db: &DbConnection, state: &ClaudeUsageState, account_key: &str, usage: &LiveUsage) {
    if !has_usable_bars(usage) {
        return;
    }
    let clean = LiveUsage {
        cached: false,
        problem: None,
        retry_at: None,
        ..usage.clone()
    };
    if let Ok(mut cache) = state.cache.lock() {
        cache.insert(account_key.to_string(), clean.clone());
    }
    if let Ok(raw) = serde_json::to_string(&clean) {
        let _ = crate::database::set_setting(db, &stored_key(account_key), &raw);
    }
}

fn account_is_api_key(db: &DbConnection, account_key: &str) -> Result<bool, String> {
    if account_key == "system:claude-code" {
        return Ok(false);
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT agent_id, kind FROM agent_accounts WHERE id = ?1",
            [account_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match row {
        Some((agent_id, kind)) if agent_id == "claude-code" => {
            Ok(AccountKind::parse(&kind) == AccountKind::ApiKey)
        }
        _ => Ok(false),
    }
}

fn load_best_known(
    db: &DbConnection,
    state: &ClaudeUsageState,
    account_key: &str,
    now: i64,
    config_path: Option<&Path>,
) -> (Option<LiveUsage>, Option<LiveUsage>) {
    let mem = state
        .cache
        .lock()
        .ok()
        .and_then(|c| c.get(account_key).cloned())
        .filter(has_usable_bars);
    let sqlite = if mem.is_none() {
        crate::database::get_setting(db, &stored_key(account_key))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<LiveUsage>(&raw).ok())
            .filter(has_usable_bars)
    } else {
        None
    };
    let stored = mem.or(sqlite);
    let passive_config = config_path.and_then(|p| read_claude_config_usage(p, now));
    let passive_quota = read_quota_fallback(db, account_key, now);

    let best_passive = [passive_config, passive_quota]
        .into_iter()
        .flatten()
        .max_by_key(|u| u.fetched_at);

    let best = [stored, best_passive.clone()]
        .into_iter()
        .flatten()
        .max_by_key(|u| u.fetched_at);

    (best, best_passive)
}

fn active_backoff(state: &ClaudeUsageState, account_key: &str, now: i64) -> Option<BackoffState> {
    state
        .backoff
        .lock()
        .ok()
        .and_then(|b| b.get(account_key).cloned())
        .filter(|b| now < b.until)
}

fn record_backoff(state: &ClaudeUsageState, account_key: &str, problem: &str, now: i64) -> i64 {
    let mut map = state.backoff.lock().unwrap_or_else(|e| e.into_inner());
    let next_failures = map
        .get(account_key)
        .map_or(1, |prev| prev.failures.saturating_add(1));
    let wait = backoff_duration_secs(problem, next_failures);
    let until = now + wait;
    map.insert(
        account_key.to_string(),
        BackoffState {
            failures: next_failures,
            until,
            problem: problem.to_string(),
        },
    );
    until
}

fn clear_backoff(state: &ClaudeUsageState, account_key: &str) {
    if let Ok(mut map) = state.backoff.lock() {
        map.remove(account_key);
    }
}

fn merge_with_fallback(
    best_known: Option<LiveUsage>,
    problem: String,
    retry_at: Option<i64>,
) -> LiveUsage {
    if !is_auth_problem(&problem)
        && let Some(prev) = best_known.filter(has_usable_bars)
    {
        return LiveUsage {
            available: true,
            cached: true,
            problem: Some(problem),
            retry_at,
            ..prev
        };
    }
    LiveUsage {
        available: false,
        session: None,
        week: None,
        week_models: Vec::new(),
        fetched_at: 0,
        cached: false,
        problem: Some(problem),
        retry_at,
    }
}

/// Núcleo testável (síncrono) da leitura de cota do Claude, sem depender de PTY real nem de `~/.ags`.
#[allow(clippy::too_many_arguments)]
pub(super) fn fetch_claude_usage_with(
    db: &DbConnection,
    state: &ClaudeUsageState,
    account_key: &str,
    force: bool,
    manual: bool,
    now: i64,
    config_path: Option<&Path>,
    probe: impl FnOnce() -> Result<(LiveUsage, Option<&'static str>), String>,
) -> Result<LiveUsage, String> {
    if account_is_api_key(db, account_key)? {
        return Ok(LiveUsage::failed("accounts.plan.problem.apiKey"));
    }

    let (best_known, best_passive) = load_best_known(db, state, account_key, now, config_path);
    if let Some(ref best) = best_known {
        store_good_snapshot(db, state, account_key, best);
    }
    let backoff = active_backoff(state, account_key, now);

    if !force {
        if let Some(ref b) = backoff {
            return Ok(merge_with_fallback(
                best_known,
                b.problem.clone(),
                Some(b.until),
            ));
        }
        if let Some(best) = best_known {
            return Ok(LiveUsage {
                cached: true,
                ..best
            });
        }
    } else if !manual {
        if let Some(passive) = best_passive.filter(|p| is_fresh_reading(p, now)) {
            clear_backoff(state, account_key);
            store_good_snapshot(db, state, account_key, &passive);
            return Ok(LiveUsage {
                cached: true,
                ..passive
            });
        }
        if let Some(ref b) = backoff {
            return Ok(merge_with_fallback(
                best_known,
                b.problem.clone(),
                Some(b.until),
            ));
        }
    }

    match probe() {
        Ok((mut usage, notice)) => {
            if has_usable_bars(&usage) {
                usage.fetched_at = now;
                usage.cached = false;
                if let Some(problem) = notice {
                    let until = record_backoff(state, account_key, problem, now);
                    store_good_snapshot(db, state, account_key, &usage);
                    usage.cached = true;
                    usage.problem = Some(problem.to_string());
                    usage.retry_at = Some(until);
                } else {
                    clear_backoff(state, account_key);
                    usage.problem = None;
                    usage.retry_at = None;
                    store_good_snapshot(db, state, account_key, &usage);
                }
                Ok(usage)
            } else {
                let problem = usage
                    .problem
                    .unwrap_or_else(|| "accounts.plan.problem.panelMissing".to_string());
                let until = record_backoff(state, account_key, &problem, now);
                Ok(merge_with_fallback(best_known, problem, Some(until)))
            }
        }
        Err(problem) => {
            let until = record_backoff(state, account_key, &problem, now);
            Ok(merge_with_fallback(best_known, problem, Some(until)))
        }
    }
}

/// Versão assíncrona com single-flight por conta e semáforo global de sondas PTY.
#[allow(clippy::too_many_arguments)]
pub(super) async fn fetch_claude_usage_async_with<F>(
    db: &DbConnection,
    state: &Arc<ClaudeUsageState>,
    account_key: &str,
    force: bool,
    manual: bool,
    now: i64,
    config_path: Option<std::path::PathBuf>,
    probe: F,
) -> Result<LiveUsage, String>
where
    F: FnOnce() -> Result<(LiveUsage, Option<&'static str>), String> + Send + 'static,
{
    if account_is_api_key(db, account_key)? {
        return Ok(LiveUsage::failed("accounts.plan.problem.apiKey"));
    }

    // Caminho rápido sem fila nem PTY quando não é atualização forçada, ou quando
    // é atualização automática com fonte passiva fresca ou backoff ativo.
    if !force || !manual {
        let (best_known, best_passive) =
            load_best_known(db, state, account_key, now, config_path.as_deref());
        let backoff = active_backoff(state, account_key, now);
        if !force {
            if let Some(b) = backoff {
                return Ok(merge_with_fallback(best_known, b.problem, Some(b.until)));
            }
            if let Some(best) = best_known {
                store_good_snapshot(db, state, account_key, &best);
                return Ok(LiveUsage {
                    cached: true,
                    ..best
                });
            }
        } else if let Some(passive) = best_passive.filter(|p| is_fresh_reading(p, now)) {
            clear_backoff(state, account_key);
            store_good_snapshot(db, state, account_key, &passive);
            return Ok(LiveUsage {
                cached: true,
                ..passive
            });
        } else if let Some(b) = backoff {
            return Ok(merge_with_fallback(best_known, b.problem, Some(b.until)));
        }
    }

    // Single-flight por conta: se já há consulta em voo para a mesma conta, aguarda o resultado dela.
    let (sender, receiver) = {
        let mut map = state.in_flight.lock().await;
        if let Some(existing) = map.get(account_key) {
            (None, Some(existing.clone()))
        } else {
            let (tx, rx) = watch::channel(None);
            map.insert(account_key.to_string(), rx);
            (Some(tx), None)
        }
    };

    if let Some(mut rx) = receiver {
        loop {
            if let Some(result) = rx.borrow().clone() {
                return Ok(result);
            }
            if rx.changed().await.is_err() {
                break;
            }
        }
        let (best_known, _) =
            load_best_known(db, state, account_key, now, config_path.as_deref());
        return Ok(best_known.unwrap_or_else(|| LiveUsage::failed("accounts.plan.problem.timeout")));
    }

    let _permit = state
        .probe_semaphore
        .acquire()
        .await
        .map_err(|e| e.to_string())?;

    let db_clone = db.clone();
    let state_clone = state.clone();
    let key_owned = account_key.to_string();
    let result = tokio::task::spawn_blocking(move || {
        fetch_claude_usage_with(
            &db_clone,
            &state_clone,
            &key_owned,
            force,
            manual,
            now,
            config_path.as_deref(),
            probe,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(tx) = sender {
        if let Ok(ref usage) = result {
            let _ = tx.send(Some(usage.clone()));
        }
        let mut map = state.in_flight.lock().await;
        map.remove(account_key);
    }

    result
}

/// El consumo del plan de una cuenta, preguntado en vivo.
#[tauri::command]
pub async fn claude_live_usage(
    // `account_key`: con qué cuenta se preguntó. Es la clave de la caché.
    account_key: String,
    // `force`: volver a preguntar aunque haya algo guardado.
    force: bool,
    // `manual`: clique explícito do usuário (`true`) ignora backoff automático (`false`).
    manual: Option<bool>,
    db: tauri::State<'_, DbConnection>,
) -> Result<LiveUsage, String> {
    let manual = manual.unwrap_or(force);
    let system_account = account_key == "system:claude-code";
    if account_is_api_key(&db, &account_key)? {
        return Ok(LiveUsage::failed("accounts.plan.problem.apiKey"));
    }

    let env = if system_account {
        HashMap::new()
    } else if let Some(env) = crate::accounts::env_for_account(&db, &account_key) {
        env
    } else {
        return Ok(LiveUsage::failed("accounts.plan.problem.configUnavailable"));
    };

    let Some(config_path) = config_file(env.get("CLAUDE_CONFIG_DIR").map(String::as_str)) else {
        return Ok(LiveUsage::failed(
            "accounts.plan.problem.configUnavailable",
        ));
    };

    let state = GLOBAL_STATE.clone();
    let now = crate::util::now_ts();
    let env_vec: Vec<(String, String)> = env.into_iter().collect();
    let config_for_probe = config_path.clone();

    fetch_claude_usage_async_with(
        &db,
        &state,
        &account_key,
        force,
        manual,
        now,
        Some(config_path),
        move || {
            let Some(command) = crate::agents::agent_command("claude-code") else {
                return Err("accounts.plan.problem.commandUnknown".to_string());
            };
            if !crate::agents::command_exists(command) {
                return Err("accounts.plan.problem.notInstalled".to_string());
            }
            let cwd = probe_dir()?;
            let Some(cwd) = cwd.to_str().map(str::to_string) else {
                return Err("accounts.plan.problem.probePath".to_string());
            };
            trust_dir(&config_for_probe, &cwd)?;
            let screen = capture(command, &cwd, &env_vec)?;
            Ok(parse_usage_screen_with_notice(&screen))
        },
    )
    .await
}

/// El sondeo de cupo cierra como `examples/orphan_probe.rs -- contained`: el nieto que se
/// fue a su propia sesión muere con el grupo, no solo el hijo directo.
#[cfg(all(test, target_os = "linux"))]
mod capture_kills_group {
    use super::release_usage_process;
    use crate::terminal::containment::ProcessGroup;
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn vivo(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[test]
    fn el_sondeo_de_cupo_mata_al_nieto_que_se_fue_a_su_propia_sesion() {
        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("setsid sleep 30 & sleep 0.3; pgrep -n -x sleep; sleep 30");

        let mut group = ProcessGroup::new(0);
        let mut child = pty.slave.spawn_command(cmd).expect("spawn");
        group.adopt(&*child);
        if !group.is_escape_proof() {
            eprintln!(
                "omitido: sin cgroups delegados, el sondeo cae al recorrido por ppid, que \
                 por diseño no alcanza a un proceso en otra sesión."
            );
            release_usage_process(&mut group, &mut *child);
            return;
        }

        let mut reader = pty.master.try_clone_reader().expect("reader");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut acc = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(pid) = acc.split_whitespace().find_map(|w| w.parse::<u32>().ok()) {
                    let _ = tx.send(pid);
                    break;
                }
            }
        });
        let nieto = rx.recv_timeout(Duration::from_secs(10)).expect("pid del nieto");
        assert!(vivo(nieto), "el nieto tendría que estar vivo antes de cortar el sondeo");

        release_usage_process(&mut group, &mut *child);
        drop(pty);

        let limite = Instant::now() + Duration::from_secs(5);
        while vivo(nieto) && Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }
        let sobrevivio = vivo(nieto);
        if sobrevivio {
            unsafe { libc::kill(nieto as i32, libc::SIGKILL) };
        }
        assert!(!sobrevivio, "el nieto {nieto} quedó huérfano tras cortar el sondeo de cupo");
    }
}

#[cfg(all(test, windows))]
mod capture_kills_group {
    use super::release_usage_process;
    use crate::terminal::containment::{imp, ProcessGroup};
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn vivo(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }

    #[test]
    fn el_sondeo_de_cupo_mata_al_proceso_que_lanzo() {
        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("powershell");
        cmd.arg("-NoProfile");
        cmd.arg("-Command");
        cmd.arg(
            "$p = Start-Process -PassThru -WindowStyle Hidden ping \
             -ArgumentList '-n','60','127.0.0.1'; \
             Write-Output \"NIETO=$($p.Id)\"; Start-Sleep 60",
        );

        let mut group = ProcessGroup::new(0);
        let mut child = pty.slave.spawn_command(cmd).expect("spawn");
        group.adopt(&*child);
        assert!(imp::usa_job(&group.imp), "no se pudo crear el Job Object del sondeo");

        let mut reader = pty.master.try_clone_reader().expect("reader");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut acc = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(rest) = acc.split("NIETO=").nth(1) {
                    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                    if digits.len() < rest.len() {
                        if let Ok(pid) = digits.parse::<u32>() {
                            let _ = tx.send(pid);
                            break;
                        }
                    }
                }
            }
        });
        let nieto = rx.recv_timeout(Duration::from_secs(30)).expect("pid del nieto");
        assert!(vivo(nieto), "el nieto tendría que estar vivo antes de cortar el sondeo");

        release_usage_process(&mut group, &mut *child);
        drop(pty);

        let limite = Instant::now() + Duration::from_secs(5);
        while vivo(nieto) && Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!vivo(nieto), "el nieto {nieto} quedó huérfano tras cortar el sondeo de cupo");
    }
}
