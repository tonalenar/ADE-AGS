//! Cópia única das memórias aprovadas do ADE para a wiki do ai-memory (F4).
//!
//! O lock do banco fica preso só enquanto lê as entradas e grava o registro. O processo do ai-memory
//! roda sem ele. Nada é apagado, e as tabelas de memória nunca são alteradas: só `ai_memory_migration`
//! recebe linhas. Um erro do processo para a cópia; reexecutar retoma sem duplicar.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::client::{Client, PageWrite};
use crate::database::DbConnection;
use crate::memory::agent::looks_like_secret;
use crate::memory::repo_scope;
use crate::util::now_ts;

/// Contagem de uma execução. `already` são as que já estavam copiadas e iguais.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct MigrationSummary {
    pub written: usize,
    pub skipped_secret: usize,
    pub conflict: usize,
    pub divergent: usize,
    pub failed: usize,
    pub already: usize,
    /// Por que nada foi migrado (por exemplo, workspace sem pasta).
    pub reason: Option<String>,
    /// Por que a cópia parou antes do fim (por exemplo, servidor fora do ar).
    pub stopped: Option<String>,
}

/// Linha do registro, sem o corpo da memória.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct MigrationRow {
    pub entry_id: String,
    /// Chave da memória (`memory_entries.key`), só leitura. Não é o corpo.
    pub key: Option<String>,
    pub revision: i64,
    pub status: String,
    pub reason: Option<String>,
    pub wiki_path: Option<String>,
    pub aim_workspace: Option<String>,
    pub aim_project: Option<String>,
    pub migrated_at: i64,
}

/// Uma memória aprovada e atual, com o que o rodapé precisa.
struct Candidate {
    entry_id: String,
    revision: i64,
    scope: String,
    mission_id: Option<String>,
    key: String,
    kind: String,
    body: String,
    content_hash: String,
    created_at: i64,
    run_id: Option<String>,
    task_id: Option<String>,
    ttl_days: Option<i64>,
    repo_key: Option<String>,
}

/// Pasta de uma missão do workspace, com o repositório lido dos arquivos `.git` (sem rodar git).
struct Folder {
    cwd: String,
    repo_key: Option<String>,
}

/// Registro já gravado: (entry_id, revision) -> (status, body_sha256).
type Recorded = HashMap<(String, i64), (String, String)>;

enum Outcome {
    Written {
        workspace: String,
        project: String,
        path: String,
        body_sha: String,
    },
    /// Já estava na wiki, igual ao que a cópia escreveria.
    Already,
    SkippedSecret,
    Conflict,
    Divergent,
    Failed(String),
}

/// Copia as memórias aprovadas e atuais do workspace para a wiki do ai-memory.
///
/// `program` é o binário resolvido (`None` = ausente). `cwd` é a pasta da aba ativa, se o painel
/// tiver uma. Erros de entrada ou do processo que param a cópia voltam em `stopped`; o que já foi
/// gravado fica no registro.
pub fn migrate(
    db: &DbConnection,
    workspace_id: &str,
    program: Option<PathBuf>,
    cwd: Option<&str>,
) -> Result<MigrationSummary, String> {
    let cwd_folder = match cwd {
        Some(path) => {
            if !Path::new(path).is_absolute() || !Path::new(path).is_dir() {
                return Err("A pasta da aba deve ser um diretório absoluto existente.".into());
            }
            Some(Folder { cwd: path.to_string(), repo_key: repo_scope::repo_key(Path::new(path)) })
        }
        None => None,
    };
    let (candidates, folders, mut recorded) = load(db, workspace_id)?;
    let mut summary = MigrationSummary::default();

    let first = cwd_folder
        .as_ref()
        .or_else(|| folders.iter().find(|f| Path::new(&f.cwd).is_dir()));
    let Some(first) = first else {
        summary.reason = Some("workspace sem pasta: nenhuma missão com pasta existente".into());
        return Ok(summary);
    };
    let program = program.ok_or("ai-memory não encontrado no PATH.")?;
    Client::at(Some(program.clone()), PathBuf::from(&first.cwd))?.ensure_supported()?;

    for candidate in &candidates {
        let outcome = match folder_for(&folders, cwd_folder.as_ref(), candidate.repo_key.as_deref()) {
            None => Outcome::Failed("sem pasta para o repositório desta memória".into()),
            Some(cwd) => match Client::at(Some(program.clone()), PathBuf::from(cwd)) {
                Err(_) => Outcome::Failed("a pasta da missão não existe mais".into()),
                Ok(client) => match process(&client, candidate, &recorded) {
                    Ok(outcome) => outcome,
                    Err(stopped) => {
                        summary.stopped = Some(stopped);
                        break;
                    }
                },
            },
        };
        record_outcome(db, workspace_id, candidate, outcome, &mut recorded, &mut summary)?;
    }
    Ok(summary)
}

/// Linhas do registro do workspace, com a chave da memória e sem o corpo.
pub fn report(db: &DbConnection, workspace_id: &str) -> Result<Vec<MigrationRow>, String> {
    let conn = db.lock().map_err(|_| "banco indisponível".to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT m.entry_id, e.key, m.revision, m.status, m.reason, m.wiki_path, m.aim_workspace,
                    m.aim_project, m.migrated_at
             FROM ai_memory_migration m
             LEFT JOIN memory_entries e ON e.id = m.entry_id
             WHERE m.ade_workspace_id = ?1
             ORDER BY m.migrated_at, m.entry_id, m.revision",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], |r| {
            Ok(MigrationRow {
                entry_id: r.get(0)?,
                key: r.get(1)?,
                revision: r.get(2)?,
                status: r.get(3)?,
                reason: r.get(4)?,
                wiki_path: r.get(5)?,
                aim_workspace: r.get(6)?,
                aim_project: r.get(7)?,
                migrated_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Lê, sob o lock, o que a cópia precisa: candidatas, pastas das missões e o registro anterior.
fn load(
    db: &DbConnection,
    workspace_id: &str,
) -> Result<(Vec<Candidate>, Vec<Folder>, Recorded), String> {
    let conn = db.lock().map_err(|_| "banco indisponível".to_string())?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
            [workspace_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Workspace não encontrado.".into());
    }
    let candidates = candidates(&conn, workspace_id)?;
    let mut missions = conn
        .prepare("SELECT cwd FROM missions WHERE workspace_id = ?1 ORDER BY created_at DESC, id")
        .map_err(|e| e.to_string())?;
    let cwds: Vec<String> = missions
        .query_map([workspace_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut recorded = Recorded::new();
    let mut stmt = conn
        .prepare("SELECT entry_id, revision, status, body_sha256 FROM ai_memory_migration WHERE ade_workspace_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (entry, revision, status, sha) = row.map_err(|e| e.to_string())?;
        recorded.insert((entry, revision), (status, sha));
    }
    // Lock solto antes de ler os `.git` das pastas (sem git, sem processo).
    drop(stmt);
    drop(missions);
    drop(conn);

    let folders = cwds
        .into_iter()
        .map(|cwd| {
            let repo_key = repo_scope::repo_key(Path::new(&cwd));
            Folder { cwd, repo_key }
        })
        .collect();
    Ok((candidates, folders, recorded))
}

/// Só o estado atual aprovado, de escopo workspace ou missão. Pendente, rejeitada, tombstone e
/// revisão antiga ficam de fora pelo próprio SQL.
fn candidates(conn: &Connection, workspace_id: &str) -> Result<Vec<Candidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.scope, e.mission_id, e.key, r.revision, r.kind, r.body, r.content_hash,
                    r.created_at, r.source_run_id, r.source_task_id, e.ttl_days, e.repo_key
             FROM memory_entries e
             JOIN memory_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision AND r.status = 'approved'
             WHERE e.workspace_id = ?1 AND e.status = 'active' AND e.scope IN ('workspace', 'mission')
             ORDER BY e.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], |r| {
            Ok(Candidate {
                entry_id: r.get(0)?,
                scope: r.get(1)?,
                mission_id: r.get(2)?,
                key: r.get(3)?,
                revision: r.get(4)?,
                kind: r.get(5)?,
                body: r.get(6)?,
                content_hash: r.get(7)?,
                created_at: r.get(8)?,
                run_id: r.get(9)?,
                task_id: r.get(10)?,
                ttl_days: r.get(11)?,
                repo_key: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Pasta que a CLI vai usar para resolver o projeto da memória, nesta ordem:
/// 1. a pasta da aba, se o repositório dela for o da memória;
/// 2. a pasta de uma missão com o mesmo repositório;
/// 3. sem repositório na memória: a pasta da aba, senão a missão mais recente;
/// 4. nenhuma: `None` (a memória é contada como falha, com motivo).
fn folder_for<'a>(
    folders: &'a [Folder],
    cwd: Option<&'a Folder>,
    repo_key: Option<&str>,
) -> Option<&'a str> {
    let chosen = match repo_key {
        Some(key) => cwd
            .filter(|f| f.repo_key.as_deref() == Some(key))
            .or_else(|| folders.iter().find(|f| f.repo_key.as_deref() == Some(key))),
        None => cwd.or_else(|| folders.first()),
    };
    chosen.map(|f| f.cwd.as_str())
}

/// Decide o que fazer com uma memória. `Err` para a cópia (falha do processo); `Ok` é o resultado
/// dela, inclusive as recusas por conteúdo ou por conflito.
fn process(client: &Client, cand: &Candidate, recorded: &Recorded) -> Result<Outcome, String> {
    if looks_like_secret(&cand.key) || looks_like_secret(&cand.body) {
        return Ok(Outcome::SkippedSecret);
    }
    let path = wiki_path(cand);
    let body = render_body(cand);
    let body_sha = sha256_hex(body.as_bytes());
    let tags = tags_for(cand);
    let write = PageWrite {
        path: &path,
        title: &cand.key,
        kind: aim_kind(&cand.kind),
        tags: &tags,
        pinned: matches!(cand.kind.as_str(), "decision" | "constraint"),
    };
    if let Err(reason) = write.check() {
        return Ok(Outcome::Failed(reason));
    }

    // Já copiamos esta revisão antes (ou ela ficou divergente, e continua sem sobrescrever).
    let previous = recorded
        .get(&(cand.entry_id.clone(), cand.revision))
        .filter(|(status, _)| status == "written" || status == "divergent")
        .is_some();

    match client.find_page(&path)? {
        Some(page) => {
            let same = normalized(&page.body) == normalized(&body);
            Ok(match (previous, same) {
                (true, true) => Outcome::Already,
                (true, false) => Outcome::Divergent,
                // Página igual à nossa sem registro: a cópia caiu antes de gravar o registro.
                (false, true) => Outcome::Written {
                    workspace: page.workspace,
                    project: page.project,
                    path,
                    body_sha,
                },
                (false, false) => Outcome::Conflict,
            })
        }
        None => {
            client.write_page(&write, body.clone().into_bytes())?;
            Ok(match client.find_page(&path)? {
                Some(page) if normalized(&page.body) == normalized(&body) => {
                    Outcome::Written {
                        workspace: page.workspace,
                        project: page.project,
                        path,
                        body_sha,
                    }
                }
                Some(_) => Outcome::Failed(
                    "verificação: o ai-memory guardou um corpo diferente do enviado".into(),
                ),
                None => Outcome::Failed("a página não apareceu depois da escrita".into()),
            })
        }
    }
}

/// Grava o resultado no registro (sob lock próprio, curto) e soma na contagem.
fn record_outcome(
    db: &DbConnection,
    workspace_id: &str,
    cand: &Candidate,
    outcome: Outcome,
    recorded: &mut Recorded,
    summary: &mut MigrationSummary,
) -> Result<(), String> {
    let (status, reason, path, aim, body_sha) = match outcome {
        Outcome::Already => {
            summary.already += 1;
            return Ok(());
        }
        Outcome::Written { workspace, project, path, body_sha } => {
            summary.written += 1;
            ("written", None, Some(path), Some((workspace, project)), body_sha)
        }
        Outcome::SkippedSecret => {
            summary.skipped_secret += 1;
            ("skipped_secret", Some("segredo: não migra".to_string()), None, None, String::new())
        }
        Outcome::Conflict => {
            summary.conflict += 1;
            let reason = "a página já existe no ai-memory e não foi copiada por esta execução";
            ("conflict", Some(reason.to_string()), Some(wiki_path(cand)), None, String::new())
        }
        Outcome::Divergent => {
            summary.divergent += 1;
            let reason = "a página foi editada no ai-memory depois da cópia";
            ("divergent", Some(reason.to_string()), Some(wiki_path(cand)), None, String::new())
        }
        Outcome::Failed(reason) => {
            summary.failed += 1;
            ("failed", Some(reason), Some(wiki_path(cand)), None, String::new())
        }
    };
    let (aim_workspace, aim_project) = match aim {
        Some((workspace, project)) => (Some(workspace), Some(project)),
        None => (None, None),
    };
    let conn = db.lock().map_err(|_| "banco indisponível".to_string())?;
    let recorded_sha = body_sha.clone();
    conn.execute(
        "INSERT INTO ai_memory_migration
            (entry_id, revision, ade_workspace_id, content_hash, body_sha256, aim_workspace, aim_project,
             wiki_path, status, reason, migrated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(entry_id, revision) DO UPDATE SET
            status = excluded.status, reason = excluded.reason, wiki_path = excluded.wiki_path,
            aim_workspace = excluded.aim_workspace, aim_project = excluded.aim_project,
            body_sha256 = excluded.body_sha256, migrated_at = excluded.migrated_at",
        params![
            cand.entry_id,
            cand.revision,
            workspace_id,
            cand.content_hash,
            body_sha,
            aim_workspace,
            aim_project,
            path,
            status,
            reason,
            now_ts(),
        ],
    )
    .map_err(|e| e.to_string())?;
    recorded.insert((cand.entry_id.clone(), cand.revision), (status.to_string(), recorded_sha));
    Ok(())
}

/// Tipo do ai-memory para cada kind do ADE.
fn aim_kind(kind: &str) -> &'static str {
    match kind {
        "decision" => "decision",
        "constraint" => "rule",
        _ => "fact",
    }
}

/// Caminho na wiki: por id, para não depender da key (que pode ter caracteres proibidos).
fn wiki_path(cand: &Candidate) -> String {
    match &cand.mission_id {
        Some(mission) => format!("ade/missoes/{mission}/{}.md", cand.entry_id),
        None => format!("ade/memoria/{}.md", cand.entry_id),
    }
}

fn tags_for(cand: &Candidate) -> Vec<String> {
    let mut tags = vec![
        "ade".to_string(),
        "ade-migrado".to_string(),
        format!("ade-kind:{}", cand.kind),
    ];
    if let Some(mission) = &cand.mission_id {
        tags.push(format!("ade-missao:{mission}"));
    }
    tags
}

/// Corpo da página: o texto da memória e um rodapé que identifica a origem. O TTL só é anotado aqui.
fn render_body(cand: &Candidate) -> String {
    let opt = |value: Option<&str>| value.unwrap_or("-").to_string();
    format!(
        "# {key}\n\n{body}\n\n---\nMigrado do ADE AGS (cópia única; a fonte é o ADE).\n\
         ade_entry_id: {id}; revision: {rev}; content_hash: {hash}\n\
         scope: {scope}; mission: {mission}; repo_key: {repo}; ttl_days: {ttl}\n\
         added: {added}; source: ags://run/{run}/task/{task}\n",
        key = cand.key,
        body = cand.body,
        id = cand.entry_id,
        rev = cand.revision,
        hash = cand.content_hash,
        scope = cand.scope,
        mission = opt(cand.mission_id.as_deref()),
        repo = opt(cand.repo_key.as_deref()),
        ttl = cand.ttl_days.map_or("-".to_string(), |days| days.to_string()),
        added = cand.created_at,
        run = opt(cand.run_id.as_deref()),
        task = opt(cand.task_id.as_deref()),
    )
}

/// Compara sem diferença de fim de linha nem de espaço final, que o servidor pode trocar.
fn normalized(text: &str) -> String {
    text.replace("\r\n", "\n").trim_end().to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(all(test, unix))]
mod test;
