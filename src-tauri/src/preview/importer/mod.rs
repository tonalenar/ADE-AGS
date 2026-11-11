//! Importação de cookies de outro navegador para o estado cifrado do preview (7.3).
//!
//! Fontes: Chromium (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Helium), Safari, Firefox e Zen.
//! Fluxo, sempre por clique da pessoa: `browser_import_sources` lista navegadores e perfis (só estrutura de
//! pastas), `review_*` mostra domínios e contagens, e `apply_*` grava só os marcados, cifrados, pelo caminho
//! de `site.rs`, no perfil de destino da ADE. Nenhum valor de cookie sai daqui, exceto para o `Site`.
//! A chave do Chromium (Keychain no macOS, DPAPI no Windows) só é lida ao confirmar a gravação.
//! Ver `docs/ade-ags/NAVEGADOR_IMPORTACAO_PLANO.md`.

mod chromium;
mod copy;
mod firefox;
mod safari;
mod sources;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_browsers;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use super::log::SetCookie;
use super::site::Site;
use chromium::Keys;
use sources::{Context, Engine, Source, SourceInfo};

/// Um perfil que pode ser importado: id e nome, nunca o caminho.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub name: String,
}

/// Quantos cookies um domínio tem. Só a contagem: os valores nunca saem do backend.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DomainCount {
    pub domain: String,
    pub cookies: usize,
}

/// Um cookie que pode entrar: o domínio e o cookie, ainda sem origem nem momento de importação.
#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub domain: String,
    pub secure: bool,
    pub cookie: SetCookie,
}

/// O que se leu de um perfil: os cookies que podem entrar, quantos ficaram de fora (particionados ou de
/// outro contêiner) e quantos não puderam ser decifrados (Chromium: chave errada ou cifra sem chave aqui).
#[derive(Debug, Default)]
pub(crate) struct Reading {
    pub cookies: Vec<Candidate>,
    pub ignored: usize,
    pub undecryptable: usize,
}

/// O que a pessoa vê antes de marcar: os domínios, quantos cookies cada um tem e quantos ficaram de fora.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReview {
    pub profile_name: String,
    pub domains: Vec<DomainCount>,
    pub ignored: usize,
}

/// O que foi gravado, por domínio.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub domains: Vec<DomainCount>,
    pub cookies: usize,
    /// Cookies dos domínios marcados que não puderam ser decifrados e ficaram de fora.
    pub skipped: usize,
}

/// Por que a importação parou. `code` é estável (a interface traduz); `detail` é técnico e nunca tem valores.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub code: &'static str,
    pub detail: Option<String>,
}

impl ImportError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code, detail: None }
    }

    pub(crate) fn with(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// Um domínio em forma de origem de preview: sem o ponto inicial, em minúsculas. `None` se não é um host válido.
pub(crate) fn normalize_domain(host: &str) -> Option<String> {
    let domain = host.trim().trim_start_matches('.').to_ascii_lowercase();
    let valid = !domain.is_empty()
        && domain.len() <= 253
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    valid.then_some(domain)
}

/// As origens onde um cookie do domínio vale: a segura, só em https; a não segura, em http e em https
/// (o navegador a manda para os dois).
pub(crate) fn origins_for(domain: &str, secure: bool) -> Vec<String> {
    let https = format!("https://{domain}");
    if secure {
        vec![https]
    } else {
        vec![format!("http://{domain}"), https]
    }
}

/// O que se grava: as cookies de cada origem e a contagem de cada domínio marcado que existe no perfil.
struct Plan {
    by_origin: BTreeMap<String, Vec<SetCookie>>,
    counts: Vec<DomainCount>,
}

fn plan(wanted: &BTreeSet<String>, reading: &Reading, now_ms: i64) -> Plan {
    let mut by_origin: BTreeMap<String, Vec<SetCookie>> = BTreeMap::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for candidate in reading.cookies.iter().filter(|c| wanted.contains(&c.domain)) {
        *counts.entry(candidate.domain.clone()).or_default() += 1;
        for origin in origins_for(&candidate.domain, candidate.secure) {
            let mut cookie = candidate.cookie.clone();
            cookie.url = format!("{origin}/");
            cookie.at = now_ms;
            by_origin.entry(origin).or_default().push(cookie);
        }
    }
    let counts = counts.into_iter().map(|(domain, cookies)| DomainCount { domain, cookies }).collect();
    Plan { by_origin, counts }
}

fn review_of(profile_name: &str, reading: &Reading) -> ImportReview {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for candidate in &reading.cookies {
        *counts.entry(candidate.domain.clone()).or_default() += 1;
    }
    ImportReview {
        profile_name: profile_name.to_string(),
        domains: counts.into_iter().map(|(domain, cookies)| DomainCount { domain, cookies }).collect(),
        ignored: reading.ignored,
    }
}

/// Confere se o navegador está fechado. `Err` ao conferir conta como não confirmado (`lock-unknown`).
pub(crate) fn confirm_closed(target: &Path, in_use: &dyn Fn(&Path) -> Result<bool, String>) -> Result<(), ImportError> {
    match in_use(target) {
        Ok(false) => Ok(()),
        Ok(true) => Err(ImportError::new("browser-running")),
        Err(detail) => Err(ImportError::new("lock-unknown").with(detail)),
    }
}

/// O perfil de destino na ADE: o padrão ou um perfil nomeado (`profile-<uuid>`). O anônimo não guarda
/// nada e os perfis de agente não são da pessoa: nenhum dos dois recebe importação.
pub(crate) fn valid_target_profile(id: &str) -> bool {
    id == "default"
        || id.strip_prefix("profile-").is_some_and(|rest| rest.len() == 36 && rest.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
}

/// A gravação: só os domínios marcados, uma origem por vez, pelos `Site`s que `sites` devolve. `read`
/// recebe os domínios marcados (o Chromium só decifra esses).
fn apply_with(
    state: Result<(), ImportError>,
    domains: &[String],
    read: &dyn Fn(&BTreeSet<String>) -> Result<Reading, ImportError>,
    sites: &dyn Fn(&str) -> Arc<Site>,
    now_ms: i64,
) -> Result<ImportOutcome, ImportError> {
    state?;
    let wanted: BTreeSet<String> = domains.iter().filter_map(|d| normalize_domain(d)).collect();
    if wanted.is_empty() {
        return Err(ImportError::new("no-domains"));
    }
    let reading = read(&wanted)?;
    // Tudo cifrado com chave que não abre: dizer a razão em vez de "importou zero".
    if reading.cookies.iter().all(|c| !wanted.contains(&c.domain)) && reading.undecryptable > 0 {
        return Err(ImportError::new("undecryptable"));
    }
    let plan = plan(&wanted, &reading, now_ms);
    if plan.counts.is_empty() {
        return Err(ImportError::new("no-domains"));
    }
    for (origin, cookies) in plan.by_origin {
        sites(&origin)
            .import_cookies(cookies, now_ms)
            .map_err(|detail| ImportError::new("write-failed").with(detail))?;
    }
    let cookies = plan.counts.iter().map(|d| d.cookies).sum();
    Ok(ImportOutcome { domains: plan.counts, cookies, skipped: reading.undecryptable })
}

/// A revisão de um perfil do Firefox (atalho dos testes, que montam o perfil sem passar por `sources`).
#[cfg(test)]
pub(crate) fn review_profile(
    state: Result<(), ImportError>,
    root: &Path,
    profile_id: &str,
    tmp_root: &Path,
    in_use: &dyn Fn(&Path) -> Result<bool, String>,
    now_secs: i64,
) -> Result<ImportReview, ImportError> {
    state?;
    let profile = firefox::find_profile(root, profile_id)?;
    let reading = firefox::read_profile_cookies(&profile.dir, tmp_root, in_use, now_secs)?;
    Ok(review_of(&profile.name, &reading))
}

/// A importação de um perfil do Firefox (atalho dos testes).
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_profile(
    state: Result<(), ImportError>,
    root: &Path,
    profile_id: &str,
    domains: &[String],
    tmp_root: &Path,
    in_use: &dyn Fn(&Path) -> Result<bool, String>,
    sites: &dyn Fn(&str) -> Arc<Site>,
    now_ms: i64,
) -> Result<ImportOutcome, ImportError> {
    apply_with(
        state,
        domains,
        &|_| {
            let profile = firefox::find_profile(root, profile_id)?;
            firefox::read_profile_cookies(&profile.dir, tmp_root, in_use, now_ms / 1000)
        },
        sites,
        now_ms,
    )
}

/// Tudo o que a leitura de uma fonte precisa do mundo de fora. Nos testes, tudo é injetado.
pub(crate) struct Env<'a> {
    pub ctx: &'a Context,
    pub tmp_root: &'a Path,
    pub in_use: &'a dyn Fn(&Path) -> Result<bool, String>,
    /// A chave do Chromium (Keychain/DPAPI). Só é chamada ao gravar, e só se há o que decifrar.
    pub keys: &'a dyn Fn(&Source, &Context) -> Result<Keys, ImportError>,
}

fn source_of(id: &str) -> Result<&'static Source, ImportError> {
    sources::find(id).ok_or_else(|| ImportError::new("unknown-source"))
}

/// A revisão de um perfil de qualquer fonte. Chromium e Safari não pedem chave nem Keychain aqui.
pub(crate) fn review_source(
    state: Result<(), ImportError>,
    env: &Env<'_>,
    source_id: &str,
    profile_id: &str,
    now_secs: i64,
) -> Result<ImportReview, ImportError> {
    state?;
    let source = source_of(source_id)?;
    source.check_platform(env.ctx.platform)?;
    let entry = sources::find_profile(source, env.ctx, env.tmp_root, profile_id)?;
    let reading = match source.engine {
        Engine::Firefox => firefox::read_profile_cookies(&entry.dir, env.tmp_root, env.in_use, now_secs)?,
        Engine::Chromium => {
            chromium::review(&chromium::read_snapshot(&entry.cookie_db, &entry.lock_target, env.tmp_root, env.in_use)?, now_secs)
        }
        Engine::Safari => safari::read_cookie_file(&entry.cookie_db, now_secs)?,
    };
    Ok(review_of(&entry.name, &reading))
}

/// A importação de um perfil de qualquer fonte para o perfil de destino. `sites` já é o do destino.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_source(
    state: Result<(), ImportError>,
    env: &Env<'_>,
    source_id: &str,
    profile_id: &str,
    domains: &[String],
    sites: &dyn Fn(&str) -> Arc<Site>,
    now_ms: i64,
) -> Result<ImportOutcome, ImportError> {
    apply_with(
        state,
        domains,
        &|wanted| {
            let source = source_of(source_id)?;
            source.check_platform(env.ctx.platform)?;
            let entry = sources::find_profile(source, env.ctx, env.tmp_root, profile_id)?;
            let now_secs = now_ms / 1000;
            match source.engine {
                Engine::Firefox => firefox::read_profile_cookies(&entry.dir, env.tmp_root, env.in_use, now_secs),
                Engine::Safari => safari::read_cookie_file(&entry.cookie_db, now_secs),
                Engine::Chromium => {
                    let snapshot = chromium::read_snapshot(&entry.cookie_db, &entry.lock_target, env.tmp_root, env.in_use)?;
                    // Sem nada a decifrar, a chave (e o pedido do Keychain) nem é consultada.
                    if !chromium::has_wanted(&snapshot, wanted, now_secs) {
                        return Ok(Reading::default());
                    }
                    let keys = (env.keys)(source, env.ctx)?;
                    Ok(chromium::decrypt(&snapshot, wanted, &keys, env.ctx.platform, now_secs))
                }
            }
        },
        sites,
        now_ms,
    )
}

/// A chave do Chromium neste sistema: Keychain no macOS (o macOS pede permissão), DPAPI no Windows.
fn system_keys(source: &Source, ctx: &Context) -> Result<Keys, ImportError> {
    match ctx.platform {
        sources::Platform::Mac => {
            let (service, account) = source.keychain.ok_or_else(|| ImportError::new("unsupported-platform"))?;
            let mut secret = chromium::read_keychain_secret(service, account)?;
            let keys = chromium::mac_keys(&secret);
            secret.fill(0);
            Ok(keys)
        }
        sources::Platform::Windows => {
            let root = source.root(ctx).ok_or_else(|| ImportError::new("not-installed"))?;
            let local_state = std::fs::read_to_string(root.join("Local State")).map_err(|e| copy::read_error(&e))?;
            let wrapped = chromium::windows_wrapped_key(&local_state)?;
            Ok(Keys { gcm_v10: Some(chromium::unwrap_dpapi(&wrapped)?), ..Keys::default() })
        }
        sources::Platform::Linux => Err(ImportError::new("unsupported-platform")),
    }
}

/// O estado do preview tem de estar pronto para gravar cifrado. Sem ele, a importação é recusada
/// antes de ler qualquer cookie, com a razão.
fn require_state() -> Result<(), ImportError> {
    if super::site::state_dir().is_none() {
        return Err(ImportError::new("no-state-dir"));
    }
    super::site::os_state_key()
        .map(|_| ())
        .map_err(|detail| ImportError::new("no-state-key").with(detail))
}

/// Roda `job` numa thread de bloqueio: leitura de arquivo e SQLite não podem travar o runtime.
async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, ImportError> + Send + 'static) -> Result<T, ImportError> {
    tokio::task::spawn_blocking(job)
        .await
        .unwrap_or_else(|e| Err(ImportError::new("generic").with(e.to_string())))
}

/// Se o navegador está aberto. No Unix, o Firefox usa o arquivo de bloqueio do perfil e o Chromium o
/// `SingletonLock` da raiz; no Windows, os dois travam os próprios arquivos.
fn system_in_use(engine: Engine) -> impl Fn(&Path) -> Result<bool, String> {
    move |target: &Path| match engine {
        Engine::Firefox => firefox::profile_in_use(target),
        Engine::Chromium => chromium::profile_in_use(target),
        // O Safari grava o arquivo de forma atômica e não precisa de bloqueio.
        Engine::Safari => Ok(false),
    }
}

/// Os navegadores deste computador, com perfis e o que impede importar (fechado, permissão…). Só olha
/// pastas: nenhum cookie nem chave. A interface chama isto só quando a pessoa abre o assistente.
#[tauri::command]
pub async fn browser_import_sources() -> Result<Vec<SourceInfo>, ImportError> {
    blocking(|| {
        let ctx = Context::current();
        Ok(sources::list(&ctx, &std::env::temp_dir(), &|engine, target| system_in_use(engine)(target)))
    })
    .await
}

/// A revisão de um perfil: domínios e contagens, sem valores. Só a pessoa que clicou chega aqui.
#[tauri::command]
pub async fn browser_import_review(source_id: String, profile_id: String) -> Result<ImportReview, ImportError> {
    blocking(move || {
        let ctx = Context::current();
        let source = source_of(&source_id)?;
        let in_use = system_in_use(source.engine);
        let env = Env { ctx: &ctx, tmp_root: &std::env::temp_dir(), in_use: &in_use, keys: &system_keys };
        review_source(require_state(), &env, &source_id, &profile_id, crate::util::now_ts())
    })
    .await
}

/// Grava só os domínios marcados, como cópia única, no estado cifrado do perfil de destino.
#[tauri::command]
pub async fn browser_import_apply(
    source_id: String,
    profile_id: String,
    domains: Vec<String>,
    target_profile_id: Option<String>,
) -> Result<ImportOutcome, ImportError> {
    blocking(move || {
        let target = target_profile_id.unwrap_or_else(|| "default".to_string());
        if !valid_target_profile(&target) {
            return Err(ImportError::new("invalid-target-profile"));
        }
        let ctx = Context::current();
        let source = source_of(&source_id)?;
        let in_use = system_in_use(source.engine);
        let env = Env { ctx: &ctx, tmp_root: &std::env::temp_dir(), in_use: &in_use, keys: &system_keys };
        apply_source(
            require_state(),
            &env,
            &source_id,
            &profile_id,
            &domains,
            &|origin: &str| super::site::site_for_profile(origin, &target),
            crate::util::now_ts_ms(),
        )
    })
    .await
}

/// A URL fixa do painel Acesso Total ao Disco. Nada vem da interface: só este painel abre por aqui.
const FULL_DISK_ACCESS_URL: &str = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";

/// Abre Ajustes do Sistema no painel Acesso Total ao Disco (macOS), que o Safari exige.
/// TODO(integração): unificar com `open_privacy_settings` quando o branch `fix/fusao-permissoes-macos`
/// ganhar o painel de Acesso Total ao Disco; hoje ele só cobre captura de tela e voz.
#[tauri::command]
pub fn browser_import_open_full_disk_access() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::time::Duration;
        let mut command = crate::util::spawn::hidden_command("/usr/bin/open");
        command.arg(FULL_DISK_ACCESS_URL);
        let output = crate::util::spawn::output(&mut command, Duration::from_secs(10))
            .map_err(|error| format!("Não consegui abrir os Ajustes do Sistema: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err("O macOS recusou abrir o painel Acesso Total ao Disco.".to_string())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = FULL_DISK_ACCESS_URL;
        Err("O Acesso Total ao Disco existe só no macOS.".to_string())
    }
}
