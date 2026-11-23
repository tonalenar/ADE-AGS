use serde::{Deserialize, Serialize};
use std::io;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use super::adapter::AgentAdapter;

/// Cuánto se espera a un `--version`. Una TUI que tarda más está haciendo otra cosa —una
/// migración, un chequeo de actualización, esperando algo— y la lista no puede quedar
/// colgada de ella.
const VERSION_TIMEOUT: Duration = Duration::from_secs(8);

/// Backoff inicial quando algum agente estoura o prazo sob carga; cresce até [`TIMEOUT_BACKOFF_MAX`].
pub(crate) const TIMEOUT_BACKOFF_BASE: Duration = Duration::from_secs(10);
pub(crate) const TIMEOUT_BACKOFF_MAX: Duration = Duration::from_secs(60);

/// Una TUI tal como la ve el frontend: lo que dice el registro más lo que solo se puede
/// saber sondeando esta máquina.
///
/// `resume` y `skills_dir` viajan aunque el backend no los necesite para responder: son
/// justamente los dos datos que el frontend tenía copiados en tablas propias
/// (`agentResume.ts`), y mandarlos acá es lo que le permite dejar de tenerlas.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub command: String,
    /// Flags que el frontend debe agregar al armar el comando de lanzamiento de
    /// terminales interactivas. No afecta la detección ni `--version` (`command` sigue pelado).
    pub launch_args: Option<Vec<String>>,
    pub available: bool,
    pub version: Option<String>,
    /// Dónde se encontró. `None` = no está en el PATH (ver `util::path_env::report` para
    /// saber dónde se buscó).
    pub path: Option<String>,
    /// Argumentos de reanudación con el placeholder `{session}`. `None` = no sabe.
    pub resume: Option<String>,
    /// Carpeta de skills relativa al cwd. `None` = no gestiona skills.
    pub skills_dir: Option<String>,
}

/// ¿Está este comando en el PATH?
///
/// Se mira el disco en vez de preguntarle a `which`/`where`: `which` no viene en todas las
/// distribuciones (Arch base no lo trae, y ahí no se detectaba NINGUNA TUI), y el PATH en
/// el que busca es el que armó `util::path_env` al arrancar — el mismo con el que después
/// se lanza, así que lo que se detecta es lo que se puede abrir.
pub fn command_exists(command: &str) -> bool {
    crate::util::find_program(command).is_some()
}

/// La primera línea con texto de lo que imprimió `--version`.
///
/// De stdout primero y de stderr si stdout vino vacío: hay TUIs que escriben la versión
/// en stderr, y antes eso las dejaba sin versión aunque la dijeran.
pub fn version_line(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    [stdout, stderr].into_iter().find_map(|raw| {
        String::from_utf8_lossy(raw)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_string)
    })
}

#[derive(Clone, Debug)]
pub(crate) struct ProbeOutcome {
    pub info: AgentInfo,
    pub timed_out: bool,
}

fn probe_agent(adapter: &'static dyn AgentAdapter) -> ProbeOutcome {
    let def = adapter.def();
    // El shell de emergencia se reporta disponible sin sondear. En Windows el binario ni
    // siquiera está en el PATH con ese nombre, así que sondearlo lo daría por ausente.
    let assumed = adapter.assumes_installed();
    let path = if assumed {
        None
    } else {
        crate::util::find_program(def.command)
    };

    // Con la ruta que se encontró y no con el nombre: en Windows un `opencode.cmd` de npm
    // no se ejecuta por su nombre a secas. Con tope y sin stdin: una TUI que se pone a
    // esperar algo no puede dejar colgada la lista entera.
    let mut timed_out = false;
    let version = path.as_ref().and_then(|p| {
        let mut cmd = crate::util::spawn::hidden_command(p);
        cmd.arg(def.version_flag);
        match crate::util::output_with_timeout(&mut cmd, VERSION_TIMEOUT) {
            Ok(out) if out.status.success() => version_line(&out.stdout, &out.stderr),
            Ok(_) => None,
            Err(err) => {
                if err.kind() == io::ErrorKind::TimedOut {
                    timed_out = true;
                }
                None
            }
        }
    });

    ProbeOutcome {
        info: AgentInfo {
            id: def.id.to_string(),
            label: def.label.to_string(),
            command: def.command.to_string(),
            launch_args: def
                .launch_args
                .map(|a| a.iter().map(|s| s.to_string()).collect()),
            available: assumed || path.is_some(),
            version,
            path: path.map(|p| p.to_string_lossy().into_owned()),
            resume: def.resume.map(str::to_string),
            skills_dir: def.skills_dir.map(str::to_string),
        },
        timed_out,
    }
}

/// Prazo de espera antes de tentar sondar novamente após um timeout sob carga (10s, 20s, 40s, 60s).
pub(crate) fn timeout_backoff(streak: u32) -> Duration {
    let shift = streak.saturating_sub(1).min(4);
    let secs = TIMEOUT_BACKOFF_BASE.as_secs().saturating_mul(1_u64 << shift);
    Duration::from_secs(secs).min(TIMEOUT_BACKOFF_MAX)
}

#[derive(Default)]
pub(crate) struct DetectCache {
    /// Só guarda sondas completas (sem timeout); vale por [`DETECT_TTL`].
    fresh: Option<(Instant, Vec<AgentInfo>)>,
    /// Quando algum `--version` estourou o prazo, segura novas sondas só pelo backoff curto
    /// em vez de gravar "sem versão" por 5 minutos.
    backoff: Option<TimeoutBackoff>,
}

struct TimeoutBackoff {
    until: Instant,
    streak: u32,
    partial: Vec<AgentInfo>,
}

impl DetectCache {
    pub(crate) fn lookup(&self, now: Instant, refresh: bool) -> Option<Vec<AgentInfo>> {
        if refresh {
            return None;
        }
        if let Some((at, agents)) = &self.fresh
            && now.saturating_duration_since(*at) < DETECT_TTL
        {
            return Some(agents.clone());
        }
        if let Some(backoff) = &self.backoff
            && now < backoff.until
        {
            return Some(backoff.partial.clone());
        }
        None
    }

    pub(crate) fn record(&mut self, now: Instant, outcomes: Vec<ProbeOutcome>) -> Vec<AgentInfo> {
        let any_timeout = outcomes.iter().any(|outcome| outcome.timed_out);
        let previous = self
            .fresh
            .as_ref()
            .map(|(_, agents)| agents)
            .or_else(|| self.backoff.as_ref().map(|b| &b.partial));

        let agents: Vec<AgentInfo> = outcomes
            .into_iter()
            .map(|mut outcome| {
                if outcome.timed_out
                    && outcome.info.version.is_none()
                    && let Some(prev) = previous.and_then(|list| {
                        list.iter()
                            .find(|item| item.id == outcome.info.id && item.path == outcome.info.path)
                    })
                {
                    outcome.info.version = prev.version.clone();
                }
                outcome.info
            })
            .collect();

        if any_timeout {
            // Não grava resultado com timeout como verdade por 5 min; aplica backoff curto.
            self.fresh = None;
            let streak = self.backoff.as_ref().map_or(1, |b| b.streak.saturating_add(1));
            self.backoff = Some(TimeoutBackoff {
                until: now + timeout_backoff(streak),
                streak,
                partial: agents.clone(),
            });
        } else {
            self.fresh = Some((now, agents.clone()));
            self.backoff = None;
        }
        agents
    }

    #[cfg(test)]
    pub(crate) fn has_fresh(&self) -> bool {
        self.fresh.is_some()
    }
}

fn probe_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Detecta qué agentes de IA están instalados en el PATH del sistema.
/// Siempre incluye bash como último elemento con available: true.
///
/// `probe_agent` mira el disco y lanza un `--version` bloqueante por candidato — sin
/// `spawn_blocking`, ese trabajo síncrono corre directo sobre un
/// worker thread del executor async de Tauri (esta función es `async fn` pero no tiene
/// ningún `.await` real), bloqueándolo mientras dura. Se llama una vez por cada ventana
/// nueva que monta `AppShell`, así que con varias ventanas abriéndose a la vez podía
/// demorar otros comandos async programados en ese mismo worker.
///
/// Los sondeos van en paralelo: son independientes, y en serie la lista tardaba la SUMA de
/// todos los `--version` — con uno lento, varios segundos de "no hay agentes".
///
/// El resultado se guarda [`DETECT_TTL`] quando nenhum agente estoura o prazo; se algum
/// sofrer timeout sob carga, não grava no cache de 5 min e tenta de novo após backoff curto.
/// `refresh` vuelve a sondear (el botón "buscar de nuevo" de la configuración).
#[tauri::command]
pub async fn detect_agents(refresh: Option<bool>) -> Result<Vec<AgentInfo>, String> {
    let force = refresh.unwrap_or(false);
    if let Some(cached) = DETECTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .lookup(Instant::now(), force)
    {
        return Ok(cached);
    }
    let _guard = probe_lock().lock().await;
    if let Some(cached) = DETECTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .lookup(Instant::now(), force)
    {
        return Ok(cached);
    }
    let outcomes: Vec<ProbeOutcome> = tokio::task::spawn_blocking(|| {
        std::thread::scope(|scope| {
            let probes: Vec<_> = super::adapter::adapters()
                .iter()
                .copied()
                .map(|adapter| scope.spawn(move || probe_agent(adapter)))
                .collect();
            probes.into_iter().filter_map(|p| p.join().ok()).collect()
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    let agents = DETECTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .record(Instant::now(), outcomes);
    Ok(agents)
}

/// Cuánto vale una detección antes de volver a sondear.
pub(crate) const DETECT_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

lazy_static::lazy_static! {
    static ref DETECTED: std::sync::Mutex<DetectCache> = std::sync::Mutex::new(DetectCache::default());
}

/// Dónde busca la app los programas: qué aportó el shell del usuario, qué carpetas
/// conocidas se sumaron y el PATH final. Es lo que se muestra cuando una TUI no aparece.
#[tauri::command]
pub fn agent_search_path() -> crate::util::path_env::PathReport {
    crate::util::path_env::report()
}
