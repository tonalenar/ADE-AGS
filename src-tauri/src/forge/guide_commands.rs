//! Os comandos do guia de revisão de um PR: ler o do cache e gerar um novo com UMA chamada
//! headless de um agente (somente leitura, ver `runs::oneshot`). Ver `guide.rs`.
//!
//! Nada daqui escreve no GitHub: só lê o PR (descrição, commit da cabeça, arquivos e diff).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::api::PullFile;
use super::commands::repo_api;
use super::credentials::blocking;
use super::guide::{build_prompt, load, parse_guide, pr_dir, repair_prompt, save, GuideEntry, PromptInput, CACHE_VERSION};
use super::provider::ForgeError;
use super::store::{data_dir, db};
use crate::database::DbConnection;
use crate::runs::oneshot::{read_only_agents, run_read_only, OneShot};
use crate::runs::routing::{AccountChoice, Assignment, Complexity, RouteRequest};

/// Quanto se espera por cada tentativa do modelo. Um PR grande leva minutos.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8 * 60);

/// Os PRs com um guia sendo gerado agora: um segundo pedido do mesmo PR é recusado.
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

struct InFlight(String);

impl InFlight {
    fn claim(key: String) -> Result<Self, ForgeError> {
        let mut set = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(key.clone()) {
            return Err(ForgeError::Api("O guia deste PR já está sendo gerado.".into()));
        }
        Ok(InFlight(key))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

fn guides_base(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("review-guides"))
}

/// Quem gera: o agente escolhido, ou o padrão.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideRequest {
    /// `None` = escolha automática (o tramo `standard` do ruteo, e depois a primeira TUI
    /// somente leitura disponível).
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    /// Que a conta a escolha o ruteo. Com `false`, vale `account_id` (`None` = a do sistema).
    #[serde(default = "yes")]
    pub auto_account: bool,
    #[serde(default)]
    pub model: Option<String>,
    /// Idioma da interface: o guia vem escrito nele.
    #[serde(default)]
    pub lang: Option<String>,
    /// Onde o agente roda (o worktree do PR, se houver). `None` = a pasta do repo.
    #[serde(default)]
    pub workdir: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideLookup {
    pub entry: Option<GuideEntry>,
    /// O commit da cabeça do PR agora. `None` = não se soube (sem rede, por exemplo).
    pub head_sha: Option<String>,
    /// O guia é de outro commit: o PR andou depois de gerado.
    pub stale: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideOutcome {
    /// O guia válido (já gravado). `None` = as duas tentativas falharam a validação.
    pub entry: Option<GuideEntry>,
    /// A última resposta crua, quando não deu para validar.
    pub raw: Option<String>,
    pub errors: Vec<String>,
    pub agent_id: String,
    pub model: Option<String>,
}

/// A escolha do agente. Pura sobre o roteador: `route` é `runs::route_now`.
pub(crate) fn pick_agent(
    req: &GuideRequest,
    route: impl Fn(&RouteRequest) -> Result<Assignment, String>,
) -> Result<Assignment, String> {
    let account = if req.auto_account { AccountChoice::Auto } else { AccountChoice::Fixed(req.account_id.clone()) };
    if let Some(agent) = req.agent_id.as_deref().filter(|a| !a.is_empty()) {
        if !read_only_agents().contains(&agent) {
            return Err(format!("'{agent}' não gera o guia: escolha Claude Code, Codex, Gemini ou OpenCode"));
        }
        return route(&RouteRequest {
            agent_id: Some(agent.to_string()),
            model: req.model.clone().filter(|m| !m.trim().is_empty()),
            complexity: None,
            account,
        });
    }
    let mut notes = Vec::new();
    match route(&RouteRequest { agent_id: None, model: None, complexity: Some(Complexity::Standard), account: account.clone() }) {
        Ok(a) if read_only_agents().contains(&a.agent_id.as_str()) => return Ok(a),
        Ok(a) => notes.push(format!("{}: não garante somente leitura", a.agent_id)),
        Err(e) => notes.push(e),
    }
    for agent in read_only_agents() {
        match route(&RouteRequest { agent_id: Some(agent.to_string()), model: None, complexity: None, account: account.clone() }) {
            Ok(a) => return Ok(a),
            Err(e) => notes.push(format!("{agent}: {e}")),
        }
    }
    Err(format!("Nenhum agente disponível para gerar o guia ({})", notes.join("; ")))
}

/// O guia em cache deste PR, e se ficou para trás do commit atual.
#[tauri::command]
pub async fn review_guide_get(app: AppHandle, cwd: String, number: u64) -> Result<GuideLookup, ForgeError> {
    let (t, api) = repo_api(&app, &cwd).await?;
    let head = api.pull_head_sha(&t.path, number).await.ok();
    let dir = pr_dir(&guides_base(&app)?, &t.host, &t.path, number);
    let found = {
        let head = head.clone();
        blocking(move || load(&dir, head.as_deref())).await?
    };
    Ok(match found {
        Some((entry, stale)) => GuideLookup { entry: Some(entry), head_sha: head, stale },
        None => GuideLookup { entry: None, head_sha: head, stale: false },
    })
}

/// Os arquivos de um PR com o diff de cada um (para a vista do guia).
#[tauri::command]
pub async fn forge_pull_files(app: AppHandle, cwd: String, number: u64) -> Result<Vec<PullFile>, ForgeError> {
    let (t, api) = repo_api(&app, &cwd).await?;
    api.pull_files(&t.path, number).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullCodeFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub patch: Option<String>,
    pub patch_limited: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullCode {
    pub head_sha: String,
    pub base_sha: Option<String>,
    pub start_sha: Option<String>,
    pub provider: super::provider::ForgeKind,
    pub files: Vec<PullCodeFile>,
}

/// Lista os arquivos e fixa o commit que a aba Código vai mostrar.
#[tauri::command]
pub async fn forge_pull_code(app: AppHandle, cwd: String, number: u64) -> Result<PullCode, ForgeError> {
    const MAX_PATCH_PER_FILE: usize = 512 * 1024;
    const MAX_PATCH_TOTAL: usize = 4 * 1024 * 1024;
    let (target, api) = repo_api(&app, &cwd).await?;
    for _ in 0..2 {
        let refs = api.pull_review_refs(&target.path, number).await?;
        let files = api.pull_files(&target.path, number).await?;
        if api.pull_review_refs(&target.path, number).await? == refs {
            let mut patch_bytes = 0usize;
            let files = files
                .into_iter()
                .map(|file| {
                    let mut patch = file.patch;
                    let size = patch.as_ref().map_or(0, String::len);
                    let patch_limited = size > MAX_PATCH_PER_FILE || patch_bytes.saturating_add(size) > MAX_PATCH_TOTAL;
                    if patch_limited {
                        patch = None;
                    } else {
                        patch_bytes = patch_bytes.saturating_add(size);
                    }
                    PullCodeFile {
                        path: file.path,
                        old_path: file.old_path,
                        status: file.status,
                        additions: file.additions,
                        deletions: file.deletions,
                        patch,
                        patch_limited,
                    }
                })
                .collect();
            return Ok(PullCode {
                head_sha: refs.head_sha,
                base_sha: refs.base_sha,
                start_sha: refs.start_sha,
                provider: api.kind(),
                files,
            });
        }
    }
    Err(ForgeError::Api("O PR mudou enquanto os arquivos eram carregados. Abra a aba Código novamente.".into()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullFileContent {
    pub path: String,
    pub content: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullFileContents {
    pub files: Vec<PullFileContent>,
    pub truncated: bool,
    pub head_sha: String,
}

/// Lê os arquivos alterados no snapshot do PR. O cliente envia somente caminhos; o backend
/// confirma cada um contra a lista atual do PR e limita quantidade, concorrência e bytes.
#[tauri::command]
pub async fn forge_pull_file_contents(
    app: AppHandle,
    cwd: String,
    number: u64,
    head_sha: String,
    paths: Vec<String>,
) -> Result<PullFileContents, ForgeError> {
    const MAX_FILES: usize = 300;
    const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
    const CONCURRENCY: usize = 6;

    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(ForgeError::Api(format!("Informe entre 1 e {MAX_FILES} arquivos do PR")));
    }
    let mut seen = HashSet::new();
    let paths = paths.into_iter().filter(|path| seen.insert(path.clone())).collect::<Vec<_>>();
    let (target, api) = repo_api(&app, &cwd).await?;
    let current_head = api.pull_head_sha(&target.path, number).await?;
    if current_head != head_sha {
        return Err(ForgeError::Api("PR_HEAD_CHANGED: o PR recebeu novos commits; atualize a aba Código para buscar no mesmo snapshot".into()));
    }
    let changed = api.pull_files(&target.path, number).await?;
    let allowed = changed
        .iter()
        .filter(|file| file.status != "removed")
        .map(|file| file.path.as_str())
        .collect::<HashSet<_>>();
    if let Some(path) = paths.iter().find(|path| !allowed.contains(path.as_str())) {
        return Err(ForgeError::Api(format!("O arquivo {path} não pertence aos arquivos atuais deste PR")));
    }

    let mut files = Vec::with_capacity(paths.len());
    let mut total_bytes = 0usize;
    let mut truncated = false;
    for chunk in paths.chunks(CONCURRENCY) {
        if total_bytes >= MAX_TOTAL_BYTES {
            truncated = true;
            files.extend(chunk.iter().map(|path| PullFileContent {
                path: path.clone(),
                content: None,
                error: Some("Limite total de 8 MiB atingido".into()),
            }));
            continue;
        }

        let mut tasks = tokio::task::JoinSet::new();
        for path in chunk {
            let api = api.clone();
            let repo = target.path.clone();
            let sha = head_sha.clone();
            let path = path.clone();
            tasks.spawn(async move {
                let result = api.pull_file_content(&repo, &sha, &path).await;
                (path, result)
            });
        }
        let mut batch = Vec::with_capacity(chunk.len());
        while let Some(result) = tasks.join_next().await {
            let (path, result) = result.map_err(|error| ForgeError::Api(format!("Falha ao ler arquivo do PR: {error}")))?;
            batch.push((path, result));
        }
        // A ordem da resposta corresponde à lista do PR, não à ordem de término da rede.
        batch.sort_by_key(|(path, _)| paths.iter().position(|requested| requested == path).unwrap_or(usize::MAX));
        for (path, result) in batch {
            match result {
                Ok(content) if total_bytes.saturating_add(content.len()) <= MAX_TOTAL_BYTES => {
                    total_bytes += content.len();
                    files.push(PullFileContent { path, content: Some(content), error: None });
                }
                Ok(_) => {
                    truncated = true;
                    files.push(PullFileContent {
                        path,
                        content: None,
                        error: Some("Limite total de 8 MiB atingido".into()),
                    });
                }
                Err(error) => {
                    if error.to_string().contains("limite") {
                        truncated = true;
                    }
                    files.push(PullFileContent { path, content: None, error: Some(error.to_string()) });
                }
            }
        }
    }
    Ok(PullFileContents { head_sha, files, truncated })
}

/// O que as tentativas deram: o guia (ou os erros), a última resposta crua, o custo somado e
/// quantas foram.
type Attempts = (Result<super::guide::ReviewGuide, Vec<String>>, String, Option<f64>, u32);

fn attempt(db: &DbConnection, a: &Assignment, cwd: &str, prompt: &str) -> Result<(String, Option<f64>), String> {
    let outcome = run_read_only(
        db,
        &OneShot {
            agent_id: &a.agent_id,
            account_id: a.account_id.as_deref(),
            model: a.model.as_deref(),
            cwd,
            prompt,
            timeout: ATTEMPT_TIMEOUT,
        },
    )?;
    if !outcome.ok {
        return Err(outcome.error.unwrap_or_else(|| "o agente falhou sem dizer por quê".into()));
    }
    Ok((outcome.result.unwrap_or_default(), outcome.cost_usd))
}

/// Gera o guia de revisão do PR com um agente (somente leitura), valida e grava no cache.
/// Se a resposta não valida, tenta uma vez mais com os erros; se ainda falhar, devolve a
/// resposta crua para a UI mostrar.
#[tauri::command]
pub async fn review_guide_generate(
    app: AppHandle,
    cwd: String,
    number: u64,
    request: Option<GuideRequest>,
) -> Result<GuideOutcome, ForgeError> {
    let request = request.unwrap_or_else(|| GuideRequest { auto_account: true, ..Default::default() });
    let (t, api) = repo_api(&app, &cwd).await?;
    let _claim = InFlight::claim(format!("{}/{}#{number}", t.host, t.path))?;

    let (detail, head_sha, files) = tokio::try_join!(
        api.item(&t.path, number, true),
        api.pull_head_sha(&t.path, number),
        api.pull_files(&t.path, number),
    )?;

    let workdir = request
        .workdir
        .clone()
        .filter(|w| std::path::Path::new(w).is_dir())
        .unwrap_or_else(|| t.root.clone());
    let db = db(&app)?;
    let assignment = {
        let (db, request) = (db.clone(), request.clone());
        blocking(move || pick_agent(&request, |r| crate::runs::route_now(&db, r))).await??
    };

    let prompt = build_prompt(&PromptInput {
        repo: &t.path,
        pr: &detail,
        head_sha: &head_sha,
        files: &files,
        lang: request.lang.as_deref().unwrap_or("pt-BR"),
    });
    let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

    let result = {
        let (db, a, workdir) = (db.clone(), assignment.clone(), workdir.clone());
        blocking(move || -> Result<Attempts, String> {
            let (first, cost1) = attempt(&db, &a, &workdir, &prompt)?;
            match parse_guide(&first, &paths) {
                Ok(guide) => Ok((Ok(guide), first, cost1, 1)),
                Err(errors) => {
                    let (second, cost2) = attempt(&db, &a, &workdir, &repair_prompt(&prompt, &first, &errors))?;
                    let cost = match (cost1, cost2) {
                        (None, None) => None,
                        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
                    };
                    Ok((parse_guide(&second, &paths), second, cost, 2))
                }
            }
        })
        .await??
    };

    let (parsed, raw, cost_usd, attempts) = result;
    match parsed {
        Ok(guide) => {
            let entry = GuideEntry {
                version: CACHE_VERSION,
                repo: t.path.clone(),
                number,
                head_sha,
                created_at: crate::util::now_ts_ms(),
                agent_id: assignment.agent_id.clone(),
                model: assignment.model.clone(),
                cost_usd,
                attempts,
                guide,
            };
            let dir = pr_dir(&guides_base(&app)?, &t.host, &t.path, number);
            let saved = entry.clone();
            blocking(move || save(&dir, &saved)).await??;
            Ok(GuideOutcome {
                entry: Some(entry),
                raw: None,
                errors: Vec::new(),
                agent_id: assignment.agent_id,
                model: assignment.model,
            })
        }
        Err(errors) => Ok(GuideOutcome {
            entry: None,
            raw: Some(raw),
            errors,
            agent_id: assignment.agent_id,
            model: assignment.model,
        }),
    }
}
