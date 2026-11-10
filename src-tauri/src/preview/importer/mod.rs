//! Importação de cookies de um perfil de navegador para o estado cifrado do preview (7.3, fatia 1).
//!
//! Fluxo: a pessoa escolhe um perfil do Firefox e a ADE mostra só os domínios e a contagem de
//! cookies (`review_profile`). Depois marca os domínios, e a ADE grava só esses, cifrados, pelo
//! caminho de `site.rs` (`apply_profile`). Nenhum valor de cookie sai daqui, exceto para o `Site`.
//! Só o Firefox entra nesta fatia (ver `docs/ade-ags/NAVEGADOR_IMPORTACAO_PLANO.md`).

mod firefox;
#[cfg(test)]
mod test;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use super::log::SetCookie;
use super::site::Site;

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

/// A revisão de um perfil: lê uma cópia e devolve só domínios e contagens. `state` é a checagem do
/// estado cifrado: sem ela a leitura nem começa.
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

/// A importação: grava só os domínios marcados, uma origem por vez, pelos `Site`s que `sites` devolve.
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
    state?;
    let wanted: BTreeSet<String> = domains.iter().filter_map(|d| normalize_domain(d)).collect();
    if wanted.is_empty() {
        return Err(ImportError::new("no-domains"));
    }
    let profile = firefox::find_profile(root, profile_id)?;
    let reading = firefox::read_profile_cookies(&profile.dir, tmp_root, in_use, now_ms / 1000)?;
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
    Ok(ImportOutcome { domains: plan.counts, cookies })
}

/// O que se grava: as cookies de cada origem e a contagem de cada domínio marcado que existe no perfil.
struct Plan {
    by_origin: BTreeMap<String, Vec<SetCookie>>,
    counts: Vec<DomainCount>,
}

fn plan(wanted: &BTreeSet<String>, reading: &firefox::Reading, now_ms: i64) -> Plan {
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

fn review_of(profile_name: &str, reading: &firefox::Reading) -> ImportReview {
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

/// Os perfis do Firefox deste computador (id e nome). Só lê o `profiles.ini`.
#[tauri::command]
pub async fn browser_import_profiles() -> Result<Vec<BrowserProfile>, ImportError> {
    blocking(|| {
        let root = firefox::firefox_root().ok_or_else(|| ImportError::new("no-firefox"))?;
        Ok(firefox::profiles(&root)?
            .into_iter()
            .map(|profile| BrowserProfile { id: profile.id, name: profile.name })
            .collect())
    })
    .await
}

/// A revisão de um perfil: domínios e contagens, sem valores. Só a pessoa que clicou chega aqui.
#[tauri::command]
pub async fn browser_import_review(profile_id: String) -> Result<ImportReview, ImportError> {
    blocking(move || {
        let root = firefox::firefox_root().ok_or_else(|| ImportError::new("no-firefox"))?;
        review_profile(
            require_state(),
            &root,
            &profile_id,
            &std::env::temp_dir(),
            &firefox::profile_in_use,
            crate::util::now_ts(),
        )
    })
    .await
}

/// Grava só os domínios marcados, como cópia única, no estado cifrado do preview.
#[tauri::command]
pub async fn browser_import_apply(profile_id: String, domains: Vec<String>) -> Result<ImportOutcome, ImportError> {
    blocking(move || {
        let root = firefox::firefox_root().ok_or_else(|| ImportError::new("no-firefox"))?;
        apply_profile(
            require_state(),
            &root,
            &profile_id,
            &domains,
            &std::env::temp_dir(),
            &firefox::profile_in_use,
            &|origin: &str| super::site::site_for(origin),
            crate::util::now_ts_ms(),
        )
    })
    .await
}
