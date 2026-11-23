//! A «consciência» do orquestrador pela CLI e pelo MCP: `ags system load`, a porta de entrada dos agentes novos
//! (limite de simultâneos, carga, sobreposição de áreas) e a fila de tarefas com condição (`ags team queue`).
//! A decisão é pura e fica em `chat_team::awareness`; aqui só há a cola com o app: ler o banco, medir a carga,
//! lançar a tarefa da fila e avisar o orquestrador.
//!
//! Respeita o Vigia: lançar uma conversa filha nunca digita em terminal de ninguém, e o aviso ao orquestrador vai
//! pela fila durável de mensagens, que só entrega quando a conversa dele está livre.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::peer_queue::{changed, ensure_worker};
use crate::chat_team::awareness::gate::{self, Busy};
use crate::chat_team::awareness::load::{self, Load};
use crate::chat_team::awareness::overlap;
use crate::chat_team::awareness::plan::{self, Claim, World};
use crate::chat_team::awareness::queue::{self, Cond, Ctx, Item, NewItem};
use crate::chat_team::watch_db;
use crate::conversa::store as chat;
use crate::ipc::protocol::{arg_str, arg_str_opt};
use crate::peer_queue::store::{admit, Admission, NewMessage, State};

/// A carga é lida a cada tanto no máximo: o laço da fila acorda a cada evento do chat e `ps` não é de graça.
const LOAD_TTL: Duration = Duration::from_secs(10);
/// Com uma condição de carga ou de branch pendente, o laço relê o mundo a cada tanto (não há evento para isso).
const RECHECK_MS: i64 = 30_000;

static LOAD_CACHE: Mutex<Option<(Instant, Load)>> = Mutex::new(None);

fn cached_load() -> Load {
    let mut cache = LOAD_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, load)) = cache.as_ref() {
        if at.elapsed() < LOAD_TTL {
            return load.clone();
        }
    }
    let load = load::sample();
    *cache = Some((Instant::now(), load.clone()));
    load
}

fn with_conn<T>(app: &AppHandle, f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    let db = super::shared::db(app)?;
    let conn = db.inner().lock().map_err(|e| e.to_string())?;
    f(&conn)
}

/// O orquestrador a quem um pedido responde: `parent_ref` (o MCP o escolhe pela sessão) ou o chamador provado (`from`).
fn parent_of(conn: &rusqlite::Connection, args: &Value) -> Result<Option<String>, String> {
    let reference = arg_str_opt(args, "parent_ref").or_else(|| {
        arg_str_opt(args, "from").filter(|f| !f.trim().is_empty()).map(|f| if f.starts_with("thread:") { f } else { format!("tab:{f}") })
    });
    match reference {
        Some(reference) => watch_db::parent_target(conn, &reference),
        None => Ok(None),
    }
}

/// A referência que `chat_new` espera para um pai normalizado.
fn parent_ref_of(parent: &str) -> String {
    if parent.starts_with("thread:") { parent.to_string() } else { format!("tab:{parent}") }
}

fn name_of(conn: &rusqlite::Connection, member: &str) -> String {
    let id = member.strip_prefix("thread:").unwrap_or(member);
    match chat::thread(conn, id) {
        Ok(Some(row)) if !row.title.trim().is_empty() => row.title,
        Ok(Some(row)) => crate::agents::agent_label(&row.agent_id).unwrap_or(&row.agent_id).to_string(),
        _ => member.to_string(),
    }
}

/// O que o banco sabe agora, de uma vez só.
struct Snapshot {
    limit: usize,
    states: HashMap<String, String>,
    /// `parent` de cada integrante/filho.
    parent_of: HashMap<String, String>,
    names: HashMap<String, String>,
    claims: HashMap<String, Vec<(String, Vec<String>)>>,
}

impl Snapshot {
    fn read(conn: &rusqlite::Connection, now: i64) -> Result<Snapshot, String> {
        let limit = gate::limit_from(
            conn.query_row("SELECT value FROM settings WHERE key = ?1", [gate::SETTING_MAX_AGENTS], |r| r.get::<_, String>(0)).ok().as_deref(),
        );
        let mut states = HashMap::new();
        let mut parent_of = HashMap::new();
        let mut names = HashMap::new();
        for s in watch_db::states(conn, now)? {
            names.insert(s.member.clone(), name_of(conn, &s.member));
            states.insert(s.member.clone(), s.state.to_string());
            parent_of.insert(s.member, s.parent);
        }
        let mut claims: HashMap<String, Vec<(String, Vec<String>)>> = HashMap::new();
        for parent in parent_of.values().collect::<HashSet<_>>() {
            claims.insert(parent.clone(), queue::claims(conn, parent)?);
        }
        Ok(Snapshot { limit, states, parent_of, names, claims })
    }

    /// Os que trabalham agora para `parent`.
    fn busy(&self, parent: &str) -> Vec<Busy> {
        let mut out: Vec<Busy> = self
            .parent_of
            .iter()
            .filter(|(member, p)| p.as_str() == parent && self.states.get(*member).is_some_and(|s| s == "working"))
            .map(|(member, _)| Busy { member: member.clone(), name: self.names.get(member).cloned().unwrap_or_else(|| member.clone()) })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// As áreas declaradas por quem ainda está ocupado (trabalhando ou esperando entrada).
    fn active_claims(&self, parent: &str) -> Vec<Claim> {
        let mut out = Vec::new();
        for (thread, areas) in self.claims.get(parent).into_iter().flatten() {
            let member = format!("thread:{thread}");
            if self.states.get(&member).is_some_and(|s| s == "working" || s == "waiting_input") {
                out.push(Claim { name: self.names.get(&member).cloned().unwrap_or(member), areas: areas.clone() });
            }
        }
        out
    }

    /// `--after <nome>`: o id, o `thread:<id>` ou o nome (sem diferenciar maiúsculas) de um agente deste orquestrador.
    fn resolve_member(&self, parent: &str, wanted: &str) -> Result<(String, String), String> {
        let wanted = wanted.trim();
        let own: Vec<(&String, String)> = self
            .parent_of
            .iter()
            .filter(|(_, p)| p.as_str() == parent)
            .map(|(m, _)| (m, self.names.get(m).cloned().unwrap_or_else(|| m.clone())))
            .collect();
        let by_id = own.iter().find(|(m, _)| m.as_str() == wanted || m.strip_prefix("thread:") == Some(wanted));
        if let Some((member, name)) = by_id {
            return Ok(((*member).clone(), name.clone()));
        }
        let matches: Vec<_> = own.iter().filter(|(_, name)| name.eq_ignore_ascii_case(wanted)).collect();
        match matches.as_slice() {
            [(member, name)] => Ok(((*member).clone(), name.clone())),
            [] => {
                let known: Vec<&str> = own.iter().map(|(_, n)| n.as_str()).collect();
                Err(format!("não achei o agente \"{wanted}\" entre os seus agentes ativos ({}); use o nome de `ags team list` ou o id da conversa", known.join(", ")))
            }
            _ => Err(format!("\"{wanted}\" é ambíguo: mais de um agente seu tem esse nome; use o id (thread:<id>)")),
        }
    }
}

fn load_json(load: &Load) -> Value {
    serde_json::to_value(load).unwrap_or(Value::Null)
}

fn busy_json(busy: &[Busy]) -> Value {
    serde_json::to_value(busy).unwrap_or(Value::Null)
}

// ── ags system load ──────────────────────────────────────────────────

/// `system.load`: só leitura. Com um orquestrador conhecido, diz também quantos agentes dele trabalham e se há vaga.
pub(super) fn system_load(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let (snapshot, parent) = with_conn(app, |conn| {
        let now = crate::util::now_ts_ms();
        Ok((Snapshot::read(conn, now)?, parent_of(conn, args)?))
    })?;
    let load = load::sample();
    let busy = parent.as_deref().map(|p| snapshot.busy(p)).unwrap_or_default();
    let verdict = gate::check(snapshot.limit, &busy, &load);
    Ok(json!({
        "load": load_json(&load),
        "maxAgents": snapshot.limit,
        "activeAgents": busy_json(&busy),
        "canLaunch": verdict.is_ok(),
        "why": verdict.err().map(|r| json!({ "reason": r.reason, "message": r.message })),
        "next": "Se não puder lançar, enfileire com `ags team queue add` e espere o aviso; não faça polling.",
    }))
}

// ── A porta de entrada de `chat_new` ─────────────────────────────────

/// Antes de abrir uma conversa filha: o limite, a carga e a sobreposição. `Some(recusa)` = não lance; a recusa é uma
/// resposta normal (exit 0), com o motivo e o que fazer, como a de `peer recruit`.
pub(super) fn before_spawn(app: &AppHandle, args: &Value) -> Result<Option<Value>, String> {
    let (snapshot, parent) = with_conn(app, |conn| {
        let now = crate::util::now_ts_ms();
        let parent = parent_of(conn, args)?;
        if parent.is_none() {
            return Ok((None, None));
        }
        Ok((Some(Snapshot::read(conn, now)?), parent))
    })?;
    let (Some(snapshot), Some(parent)) = (snapshot, parent) else { return Ok(None) };
    let load = cached_load();
    let busy = snapshot.busy(&parent);
    if let Err(refusal) = gate::check(snapshot.limit, &busy, &load) {
        return Ok(Some(json!({
            "refused": true,
            "reason": refusal.reason,
            "message": refusal.message,
            "maxAgents": snapshot.limit,
            "activeAgents": busy_json(&busy),
            "load": load_json(&load),
        })));
    }
    let wanted = requested_areas(args);
    if !wanted.is_empty() && !args.get("allow_overlap").and_then(Value::as_bool).unwrap_or(false) {
        let hits = overlaps(&wanted, &snapshot.active_claims(&parent));
        if !hits.is_empty() {
            let first = hits[0]["name"].as_str().unwrap_or("o outro agente").to_string();
            return Ok(Some(json!({
                "refused": true,
                "reason": gate::REASON_OVERLAP,
                "message": format!("outra tarefa ativa mexe na mesma área ({first}). Serialize: `ags team queue add --after \"{first}\" --area <áreas> --task \"...\"` e a ADE lança quando ele terminar (e parta do branch dele). Só repita com allow_overlap=true se tiver certeza de que não haverá conflito."),
                "overlaps": hits,
            })));
        }
    }
    Ok(None)
}

/// Depois de abrir a filha: guarda as áreas declaradas, para a próxima tarefa se comparar com elas.
pub(super) fn after_spawn(app: &AppHandle, args: &Value, created: &Value) {
    let areas = requested_areas(args);
    let Some(thread) = created.pointer("/thread/id").and_then(Value::as_str) else { return };
    if areas.is_empty() {
        return;
    }
    let _ = with_conn(app, |conn| {
        let Some(parent) = parent_of(conn, args)? else { return Ok(()) };
        queue::claim_save(conn, thread, &parent, &areas, crate::util::now_ts_ms())
    });
}

fn requested_areas(args: &Value) -> Vec<String> {
    let raw: Vec<String> = match args.get("areas").or_else(|| args.get("area")) {
        Some(Value::Array(list)) => list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        Some(Value::String(text)) => vec![text.clone()],
        _ => Vec::new(),
    };
    overlap::parse(&raw)
}

fn overlaps(wanted: &[String], claims: &[Claim]) -> Vec<Value> {
    claims
        .iter()
        .filter_map(|claim| {
            let shared = overlap::shared(wanted, &claim.areas);
            (!shared.is_empty()).then(|| json!({ "name": claim.name, "areas": shared }))
        })
        .collect()
}

// ── ags team queue ───────────────────────────────────────────────────

/// `team.queue`: `add`, `list` (padrão) e `cancel`.
pub(super) fn team_queue(app: &AppHandle, args: &Value) -> Result<Value, String> {
    match arg_str_opt(args, "action").as_deref().unwrap_or("list") {
        "add" => queue_add(app, args),
        "list" | "ls" => queue_list(app, args),
        "cancel" => queue_cancel(app, args),
        other => Err(format!("Ação desconhecida: {other}. Use add, list ou cancel")),
    }
}

fn wake(app: &AppHandle) {
    crate::bus::publish(Some(app), crate::bus::Publish::new(super::conversas::BUS_TOPIC).data(json!({ "type": "queue" })));
}

fn split_list(args: &Value, key: &str) -> Vec<String> {
    let raw = match args.get(key) {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(list)) => list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    };
    raw.iter().flat_map(|t| t.split(',')).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

fn queue_add(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = arg_str_opt(args, "task").or_else(|| arg_str_opt(args, "text")).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
        .ok_or("Falta a tarefa: ags team queue add --task \"...\" (--after <agente> | --when-load-low | --after-branch <branch>)")?;
    let context = arg_str_opt(args, "context");
    crate::runs::delegated_prompt(&task, context.as_deref())?;
    let areas = requested_areas(args);
    let (item, snapshot, parent) = with_conn(app, |conn| {
        let now = crate::util::now_ts_ms();
        let parent = parent_of(conn, args)?.ok_or("A fila do time é de um orquestrador: use dentro de uma conversa ou aba da ADE")?;
        let snapshot = Snapshot::read(conn, now)?;
        let mut conditions = Vec::new();
        for wanted in split_list(args, "after") {
            let (member, name) = snapshot.resolve_member(&parent, &wanted)?;
            conditions.push(Cond { kind: queue::KIND_MEMBER_DONE.into(), target: Some(member), label: Some(name) });
        }
        if args.get("whenLoadLow").or_else(|| args.get("when_load_low")).and_then(Value::as_bool).unwrap_or(false) {
            conditions.push(Cond { kind: queue::KIND_LOAD_LOW.into(), target: None, label: None });
        }
        for branch in split_list(args, "afterBranch").into_iter().chain(split_list(args, "after_branch")) {
            conditions.push(Cond { kind: queue::KIND_BRANCH.into(), target: Some(branch.clone()), label: Some(branch) });
        }
        let cwd = match arg_str_opt(args, "cwd").filter(|c| !c.trim().is_empty()) {
            Some(cwd) => cwd,
            None => parent_cwd(conn, &parent)?,
        };
        let mut stored = serde_json::Map::new();
        for key in ["agent", "model", "effort", "account", "context", "access"] {
            if let Some(value) = args.get(key).and_then(Value::as_str).filter(|v| !v.trim().is_empty()) {
                stored.insert(key.to_string(), json!(value));
            }
        }
        if let Some(value) = args.get("account_id").and_then(Value::as_str) {
            stored.entry("account").or_insert(json!(value));
        }
        let title = arg_str_opt(args, "title").filter(|t| !t.trim().is_empty()).unwrap_or_else(|| title_of(&task));
        let item = queue::enqueue(
            conn,
            &NewItem { parent: &parent, cwd: &cwd, title: &title, task: &task, args: &Value::Object(stored), areas: &areas, conditions: &conditions },
            now,
        )?;
        Ok((item, snapshot, parent))
    })?;
    let load = cached_load();
    let branches = existing_branches(std::slice::from_ref(&item));
    let reasons = reasons_for(&item, &snapshot, &load, &branches, &[], &[]);
    // Só avisa a sobreposição: a espera é do orquestrador decidir.
    let advisory = overlaps(&areas, &snapshot.active_claims(&parent));
    wake(app);
    Ok(json!({
        "queued": true,
        "id": item.id,
        "title": item.title,
        "waitingOn": reasons,
        "overlaps": advisory,
        "next": "A ADE lança sozinha quando as condições valerem e avisa você. Não faça polling: siga o seu trabalho ou espere o aviso, e diga ao usuário por que está aguardando. `ags team queue list` mostra a fila.",
    }))
}

fn parent_cwd(conn: &rusqlite::Connection, parent: &str) -> Result<String, String> {
    if let Some(id) = parent.strip_prefix("thread:") {
        return chat::thread(conn, id).map_err(|e| e.to_string())?.map(|t| t.cwd).ok_or_else(|| "a conversa do orquestrador não existe mais".into());
    }
    conn.query_row("SELECT cwd FROM tabs WHERE id = ?1", [parent], |r| r.get::<_, String>(0)).map_err(|_| "não achei a pasta do orquestrador".to_string())
}

fn title_of(task: &str) -> String {
    let first = task.lines().next().unwrap_or("").trim();
    let mut title: String = first.chars().take(60).collect();
    if title.is_empty() {
        title = "Tarefa da fila".into();
    }
    title
}

fn queue_list(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let all = args.get("all").and_then(Value::as_bool).unwrap_or(false);
    let parent = with_conn(app, |conn| parent_of(conn, args))?;
    list_view(app, parent.as_deref(), all)
}

fn list_view(app: &AppHandle, parent: Option<&str>, all: bool) -> Result<Value, String> {
    let (items, snapshot) = with_conn(app, |conn| Ok((queue::list(conn, parent, all)?, Snapshot::read(conn, crate::util::now_ts_ms())?)))?;
    Ok(json!({ "items": view(&items, &snapshot), "maxAgents": snapshot.limit }))
}

/// A fila para a tela do time: `parent` é a conversa do orquestrador (`thread:<id>` ou o id da aba); sem ele, todas.
pub fn queue_for_ui(app: &AppHandle, parent: Option<String>, all: bool) -> Result<Value, String> {
    list_view(app, parent.as_deref(), all)
}

/// Cancelar pela tela: é a pessoa, então vale para qualquer orquestrador.
pub fn cancel_for_ui(app: &AppHandle, id: &str) -> Result<bool, String> {
    let cancelled = with_conn(app, |conn| queue::cancel(conn, id, None, crate::util::now_ts_ms()))?;
    if cancelled {
        wake(app);
    }
    Ok(cancelled)
}

/// Cada item com o motivo de espera de agora (a carga e os branches se leem fora do lock do banco).
fn view(items: &[Item], snapshot: &Snapshot) -> Vec<Value> {
    let load = cached_load();
    let pending: Vec<Item> = items.iter().filter(|i| i.status == queue::PENDING).cloned().collect();
    let branches = existing_branches(&pending);
    items
        .iter()
        .map(|item| {
            let waiting = if item.status == queue::PENDING { reasons_for(item, snapshot, &load, &branches, &[], &[]) } else { Vec::new() };
            let mut value = serde_json::to_value(item).unwrap_or(Value::Null);
            value["waitingOn"] = json!(waiting);
            value
        })
        .collect()
}

fn queue_cancel(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "id").map_err(|_| "Falta o id: ags team queue cancel <id>".to_string())?;
    let cancelled = with_conn(app, |conn| {
        let parent = parent_of(conn, args)?;
        queue::cancel(conn, &id, parent.as_deref(), crate::util::now_ts_ms())
    })?;
    if cancelled {
        wake(app);
    }
    Ok(json!({ "cancelled": cancelled, "id": id }))
}

// ── O mundo e o lançador ─────────────────────────────────────────────

/// Os branches citados por itens pendentes que existem na pasta do item (git, fora do lock do banco).
fn existing_branches(items: &[Item]) -> HashSet<String> {
    let mut found = HashSet::new();
    for item in items {
        for branch in queue::branches_wanted(std::slice::from_ref(item)) {
            if found.contains(&branch) {
                continue;
            }
            let exists = |reference: &str| {
                let mut cmd = crate::util::spawn::hidden_command("git");
                cmd.arg("-C").arg(crate::util::external_path(std::path::Path::new(&item.cwd)));
                cmd.args(["rev-parse", "--verify", "--quiet", &format!("{reference}^{{commit}}")]);
                crate::util::spawn::output(&mut cmd, Duration::from_secs(10)).map(|o| o.status.success()).unwrap_or(false)
            };
            if exists(&branch) || exists(&format!("origin/{branch}")) {
                found.insert(branch);
            }
        }
    }
    found
}

fn reasons_for(item: &Item, snapshot: &Snapshot, load: &Load, branches: &HashSet<String>, launched: &[Busy], extra_claims: &[Claim]) -> Vec<String> {
    let mut active = snapshot.busy(&item.parent);
    active.extend(launched.iter().cloned());
    let mut claims = snapshot.active_claims(&item.parent);
    claims.extend(extra_claims.iter().cloned());
    let world = World { ctx: Ctx { states: &snapshot.states, load, branches }, limit: snapshot.limit, active: &active, claims: &claims };
    plan::hold_reasons(item, &world)
}

/// Uma passada da fila: lança o que pode e avisa o orquestrador. Devolve em quantos ms olhar de novo (há uma condição
/// que depende da carga ou de um branch e nenhum evento a anuncia).
pub(crate) fn tick(app: &AppHandle) -> Result<Option<i64>, String> {
    let (items, snapshot) = with_conn(app, |conn| {
        let items = queue::list(conn, None, false)?;
        if items.is_empty() {
            return Ok((items, None));
        }
        Ok((items, Some(Snapshot::read(conn, crate::util::now_ts_ms())?)))
    })?;
    let Some(snapshot) = snapshot else { return Ok(None) };
    let load = cached_load();
    let branches = existing_branches(&items);
    let mut launched: HashMap<String, Vec<Busy>> = HashMap::new();
    let mut taken: HashMap<String, Vec<Claim>> = HashMap::new();
    let mut changed_any = false;
    for item in &items {
        let extra = launched.get(&item.parent).cloned().unwrap_or_default();
        let claims = taken.get(&item.parent).cloned().unwrap_or_default();
        let reasons = reasons_for(item, &snapshot, &load, &branches, &extra, &claims);
        if !reasons.is_empty() {
            let text = reasons.join("; ");
            if text != item.reason {
                // A tela do time mostra o motivo: ela relê quando ele muda.
                let _ = with_conn(app, |conn| queue::set_reason(conn, &item.id, &text, crate::util::now_ts_ms()));
                changed_any = true;
            }
            continue;
        }
        if !with_conn(app, |conn| queue::claim_launch(conn, &item.id, crate::util::now_ts_ms()))? {
            continue;
        }
        changed_any = true;
        match launch(app, item) {
            Ok(thread) => {
                let busy = Busy { member: format!("thread:{thread}"), name: item.title.clone() };
                launched.entry(item.parent.clone()).or_default().push(busy);
                if !item.areas.is_empty() {
                    taken.entry(item.parent.clone()).or_default().push(Claim { name: item.title.clone(), areas: item.areas.clone() });
                }
                tell_parent(app, item, &format!("[Fila do time] Lancei a tarefa \"{}\" (conversa thread:{thread}): as condições valeram. O resultado chega como as outras entregas; não precisa consultar.", item.title));
            }
            Err(error) => {
                let _ = with_conn(app, |conn| queue::mark_failed(conn, &item.id, &error, crate::util::now_ts_ms()));
                tell_parent(app, item, &format!("[Fila do time] Não consegui lançar a tarefa \"{}\": {error}. Ela saiu da fila; reenfileire ou use chat_new.", item.title));
            }
        }
    }
    if changed_any {
        wake(app);
    }
    let still = with_conn(app, |conn| queue::list(conn, None, false))?;
    Ok(queue::needs_load_timer(&still).then_some(RECHECK_MS))
}

fn launch(app: &AppHandle, item: &Item) -> Result<String, String> {
    let mut args = item.args.as_object().cloned().unwrap_or_default();
    args.insert("text".into(), json!(item.task));
    args.insert("cwd".into(), json!(item.cwd));
    args.insert("title".into(), json!(item.title));
    args.insert("parent_ref".into(), json!(parent_ref_of(&item.parent)));
    args.insert("client_request_id".into(), json!(format!("queue-{}", item.id)));
    args.insert("harness_delivery".into(), json!("async"));
    let created = super::conversas::spawn_child(app, &Value::Object(args))?;
    let thread = created.pointer("/thread/id").and_then(Value::as_str).ok_or("a conversa não foi criada")?.to_string();
    let now = crate::util::now_ts_ms();
    let _ = with_conn(app, |conn| {
        queue::set_thread(conn, &item.id, &thread, now)?;
        queue::claim_save(conn, &thread, &item.parent, &item.areas, now)
    });
    Ok(thread)
}

/// O aviso vai DO orquestrador PARA ele mesmo, pela fila durável: só chega quando a conversa dele está livre.
fn tell_parent(app: &AppHandle, item: &Item, text: &str) {
    let key = format!("queue-{}-{}", item.id, if text.contains("Não consegui") { "falhou" } else { "lancada" });
    let sent = with_conn(app, |conn| {
        let now = crate::peer_queue::store::db_now(conn)?;
        let new = NewMessage {
            client_id: Some(&key),
            kind: "notice",
            from_tab_id: &item.parent,
            from_name: "Fila do time",
            to_tab_id: &item.parent,
            to_name: "orquestrador",
            text,
            raw: true,
            reply: false,
            envelope: None,
            limits: None,
        };
        match admit(conn, &new, State::Queued, now)? {
            Admission::New(msg) => Ok(Some(msg)),
            _ => Ok(None),
        }
    });
    if let Ok(Some(msg)) = sent {
        changed(app, Some(&msg.to_tab_id));
        ensure_worker(app, &msg.to_tab_id);
    }
}
