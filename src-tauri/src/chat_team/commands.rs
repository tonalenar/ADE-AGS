//! Os comandos Tauri do time (a tela do modo chat). A pessoa pode tudo aqui, inclusive aumentar a
//! política de um integrante e desfazer o time; o agente, pela CLI, não (`ipc/commands/team.rs`).
//!
//! Cada mudança avisa a janela com `cc-chat-team`; o canvas (as cordas) a tela aplica sozinha, porque
//! é ela quem o guarda.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::database::DbConnection;

use super::api::{self, FeedItem, NewTeam, TeamView};
use super::model::{self, Named, Policy};
use super::store::{MemberPatch, MemberRow, NewMember};

/// O evento que a tela escuta para reler os times.
pub const EVENT: &str = "cc-chat-team";

pub fn announce(app: &AppHandle, team_id: &str) {
    let _ = app.emit(EVENT, json!({ "teamId": team_id }));
}

fn lock(db: &DbConnection) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    db.lock().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_team_list(db: State<'_, DbConnection>) -> Result<Vec<TeamView>, String> {
    api::list(&*lock(&db)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    pub orchestrator: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub title: String,
}

#[tauri::command]
pub fn chat_team_create(app: AppHandle, db: State<'_, DbConnection>, input: CreateInput) -> Result<TeamView, String> {
    let (team, _) = api::create(
        &*lock(&db)?,
        NewTeam { orchestrator: input.orchestrator, agent_id: input.agent_id, label: input.label, cwd: input.cwd, title: input.title },
        crate::util::now_ts_ms(),
    )?;
    announce(&app, &team.team.id);
    Ok(team)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    pub team_id: String,
    pub member: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub policy: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    pub member: MemberRow,
    /// O texto que o integrante recebe ao entrar (a tela o manda à aba ou à conversa).
    pub briefing: String,
    pub role_label: String,
}

/// O papel do catálogo pelo id: o rótulo e as instruções (vazio se for um rótulo livre).
pub fn role_info(role: &str) -> (String, String) {
    let all = crate::canvas::roles::all();
    match crate::canvas::roles::resolve(&all, role) {
        Ok(found) => (found.label.clone(), found.instructions.clone()),
        Err(_) => (role.to_string(), String::new()),
    }
}

/// O briefing de quem entra. Pura sobre o papel já resolvido.
pub fn briefing_for(orchestrator: &str, member: &MemberRow, role_label: &str, instructions: &str) -> String {
    let me = Named { name: &member.label, agent: &member.agent_id, role: role_label, policy: member.policy, branch: member.branch.as_deref() };
    model::member_briefing(orchestrator, &me, instructions)
}

#[tauri::command]
pub fn chat_team_link(app: AppHandle, db: State<'_, DbConnection>, input: LinkInput) -> Result<Linked, String> {
    let policy = input.policy.as_deref().map(Policy::parse).transpose()?;
    let roles = crate::canvas::roles::all();
    let role = if input.role.trim().is_empty() { String::new() } else { model::role_id(&roles, &input.role).unwrap_or_else(|| input.role.trim().to_string()) };
    let new = NewMember {
        member: input.member,
        agent_id: input.agent_id,
        label: input.label,
        role,
        model: input.model,
        policy,
        branch: input.branch,
        worktree: input.worktree,
        origin: input.origin.unwrap_or_else(|| "existing".into()),
    };
    let (member, orchestrator) = {
        let conn = lock(&db)?;
        let member = api::link(&conn, &input.team_id, new, false, crate::util::now_ts_ms())?;
        let team = crate::chat_team::store::team(&conn, &input.team_id)?.ok_or("Esse time não existe mais.")?;
        let name = api::orchestrator_peer_name(&conn, &team);
        (member, name)
    };
    let (role_label, instructions) = role_info(&member.role);
    let briefing = briefing_for(&orchestrator, &member, &role_label, &instructions);
    announce(&app, &input.team_id);
    Ok(Linked { member, briefing, role_label })
}

#[tauri::command]
pub fn chat_team_unlink(app: AppHandle, db: State<'_, DbConnection>, team_id: String, member: String) -> Result<bool, String> {
    let done = api::unlink(&*lock(&db)?, &team_id, &member, crate::util::now_ts_ms())?;
    announce(&app, &team_id);
    Ok(done)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInput {
    pub team_id: String,
    pub member: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub policy: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[tauri::command]
pub fn chat_team_update(app: AppHandle, db: State<'_, DbConnection>, input: UpdateInput) -> Result<MemberRow, String> {
    let roles = crate::canvas::roles::all();
    let patch = MemberPatch {
        role: input.role.map(|r| model::role_id(&roles, &r).unwrap_or_else(|| r.trim().to_string())),
        policy: input.policy.as_deref().map(Policy::parse).transpose()?,
        label: input.label.map(|l| model::clean_label(&l)),
        ..Default::default()
    };
    let row = api::update(&*lock(&db)?, &input.team_id, &input.member, patch, false, crate::util::now_ts_ms())?;
    announce(&app, &input.team_id);
    Ok(row)
}

/// Desfaz o time. As conversas continuam abertas; só as ligações saem (a tela tira as cordas).
#[tauri::command]
pub fn chat_team_dissolve(app: AppHandle, db: State<'_, DbConnection>, team_id: String) -> Result<bool, String> {
    let done = crate::chat_team::store::delete_team(&*lock(&db)?, &team_id)?;
    announce(&app, &team_id);
    Ok(done)
}

/// As delegações e entregas do time, para os cartões do fio do orquestrador.
#[tauri::command]
pub fn chat_team_feed(db: State<'_, DbConnection>, team_id: String, limit: Option<i64>) -> Result<Vec<FeedItem>, String> {
    let conn = lock(&db)?;
    let team = crate::chat_team::store::team(&conn, &team_id)?.ok_or("Esse time não existe mais.")?;
    let view = api::view(&conn, team)?;
    api::feed(&conn, &view, limit.unwrap_or(60).clamp(1, 500))
}

/// O Handoff v1 inteiro de uma entrega do time (`ENTREGA #id`), para o resumo no fio.
#[tauri::command]
pub fn chat_team_handoff(db: State<'_, DbConnection>, team_id: String, id: i64) -> Result<Value, String> {
    let conn = lock(&db)?;
    let (scope, from, payload) = crate::missions::messages::handoff(&conn, id)?.ok_or_else(|| format!("Não existe a entrega #{id}."))?;
    if scope != format!("t:{team_id}") {
        return Err(format!("A entrega #{id} é de outro time."));
    }
    let handoff: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    Ok(json!({ "id": id, "from": from, "handoff": handoff }))
}

/// O resumo do time para o orquestrador (vai junto da próxima mensagem do modo Time). Os nomes são os
/// gravados; a tela pode trocar pelos títulos atuais.
#[tauri::command]
pub fn chat_team_notice(db: State<'_, DbConnection>, team_id: String) -> Result<String, String> {
    let conn = lock(&db)?;
    let team = crate::chat_team::store::team(&conn, &team_id)?.ok_or("Esse time não existe mais.")?;
    let view = api::view(&conn, team)?;
    Ok(api::roster_notice(&view, |_| None, |role| role_info(role).0))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberWorktree {
    /// Onde o integrante roda: a mesma subpasta do repo, dentro do worktree.
    pub cwd: String,
    pub branch: String,
    pub root: String,
}

/// Um worktree novo para um integrante, na branch `team/<papel>` (com um sufixo curto se ela já
/// existir), a partir do último commit da pasta do orquestrador. Pelo mesmo `runs::worktrees` da frota,
/// na pasta das conversas (`chat-worktrees`). Nunca apaga nem força nada.
#[tauri::command]
pub async fn chat_team_worktree(cwd: String, role: String) -> Result<MemberWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = crate::util::datadir::ags_home().ok_or("Pasta de dados indisponível")?;
        let base = home.join("chat-worktrees");
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let branch = model::branch_for(&role);
        let repo = std::path::Path::new(&cwd);
        let wt = match crate::runs::worktrees::create_named(&base, repo, &branch, "HEAD") {
            Ok(wt) => wt,
            Err(_) => {
                let short = uuid::Uuid::new_v4().simple().to_string()[..4].to_string();
                crate::runs::worktrees::create_named(&base, repo, &format!("{branch}-{short}"), "HEAD")?
            }
        };
        Ok(MemberWorktree { cwd: wt.task_cwd.to_string_lossy().into_owned(), branch: wt.branch, root: wt.root.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?
}
