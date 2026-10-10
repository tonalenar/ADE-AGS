//! Teto de rodadas de correção, compartilhado pelo canvas e pela frota.
//!
//! Uma entrega pode falhar e voltar para correção. Sem teto, cada volta repete a
//! verificação. O contador não é o `attempt` da tarefa (esse zera no reroute): é o
//! número de correções já abertas para o mesmo trabalho, dentro do run ou da missão.
//!
//! O mesmo trabalho é a chave normalizada do objetivo. Um `corrects` explícito, o
//! mesmo título depois de tirar prefixos como "correção:" e a recriação da task
//! apontam para a mesma chave. Reroute e troca de worker não mexem nela.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

use super::store;
use super::types::{status, Task};

pub const DEFAULT_MAX: i64 = 2;
pub const SETTING_KEY: &str = "fix_rounds.max";
pub const ENV_KEY: &str = "ADE_AGS_MAX_FIX_ROUNDS";
const MAX_CAP: i64 = 20;
pub const MARKER: &str = "AGS-CORRECTION";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailureOutcome {
    Ignored,
    Retried { round: i64, full_gate: bool },
    Escalated { message: String, rounds: i64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CanvasOutcome {
    Deliver { text: String, round: i64, full_gate: bool, work_key: String },
    Escalated { message: String, rounds: i64, work_key: String },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FixView {
    pub scope: String,
    pub work_key: String,
    pub label: String,
    pub rounds: i64,
    pub max_rounds: i64,
    pub status: String,
    pub failures: Vec<String>,
    pub full_gate: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Note {
    round: i64,
    reason: String,
}

struct Ledger {
    rounds: i64,
    failures: Vec<Note>,
    status: String,
    extra_granted: bool,
    extras_used: i64,
    label: String,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            rounds: 0,
            failures: Vec::new(),
            status: "open".into(),
            extra_granted: false,
            extras_used: 0,
            label: String::new(),
        }
    }
}

struct Sibling {
    plan_key: Option<String>,
    id: String,
    title: String,
    work_key: String,
    status: String,
}

pub fn scope_run(run_id: &str) -> String {
    format!("run:{run_id}")
}

pub fn scope_mission(mission_id: &str) -> String {
    format!("mission:{mission_id}")
}

/// Teto vigente: variável de ambiente, senão a chave `fix_rounds.max`, senão 2.
pub fn max_rounds(conn: &Connection) -> i64 {
    if let Ok(raw) = std::env::var(ENV_KEY) {
        if let Some(n) = parse_limit(&raw) {
            return n;
        }
    }
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [SETTING_KEY], |row| row.get(0))
        .optional()
        .ok()
        .flatten();
    stored.and_then(|raw| parse_limit(&raw)).unwrap_or(DEFAULT_MAX)
}

fn parse_limit(raw: &str) -> Option<i64> {
    let n = raw.trim().parse::<i64>().ok()?;
    if (0..=MAX_CAP).contains(&n) { Some(n) } else { None }
}

pub fn fingerprint(title: &str) -> String {
    let mut text = fold(title);
    loop {
        let next = strip_correction_prefix(&text);
        if next == text {
            break;
        }
        text = next;
    }
    let slug = slugify(&text);
    if slug.is_empty() { "trabalho".into() } else { slug }
}

pub fn has_correction_prefix(text: &str) -> bool {
    let folded = fold(text);
    strip_correction_prefix(&folded) != folded
}

fn fold(text: &str) -> String {
    let mut out = String::new();
    for ch in text.trim().chars() {
        let lower = ch.to_lowercase().next().unwrap_or(ch);
        let mapped = match lower {
            'á' | 'à' | 'ã' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'õ' | 'ô' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            other => other,
        };
        out.push(mapped);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_correction_prefix(folded: &str) -> String {
    const WORDS: &[&str] = &[
        "correcao", "correção", "correccion", "correction", "corrigir", "corrija", "corrigir",
        "fix", "fixes", "retry", "rework", "rodada", "tentativa", "devolvida", "devolvido", "reprova", "reprovado",
    ];
    let rest = folded.trim();
    for word in WORDS {
        let folded_word = fold(word);
        if let Some(after) = rest.strip_prefix(folded_word.as_str()) {
            // "fix" não pode comer "prefix". O prefixo de correção é uma palavra inteira.
            let boundary = after.chars().next().is_none_or(|c| !c.is_ascii_alphanumeric());
            if !boundary {
                continue;
            }
            let after = after.trim_start_matches(|c: char| c.is_ascii_digit() || c == ':' || c == '-' || c == '#' || c.is_whitespace());
            if after.len() < rest.len() && !after.is_empty() {
                return after.trim().to_string();
            }
        }
    }
    rest.to_string()
}

fn slugify(text: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            dash = false;
        } else if !dash && !slug.is_empty() {
            slug.push('-');
            dash = true;
        }
        if slug.len() >= 80 {
            break;
        }
    }
    slug.trim_matches('-').to_string()
}

fn explicit_token(corrects: Option<&str>, prompt: &str) -> Option<String> {
    if let Some(token) = corrects.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(token.to_string());
    }
    let lower = prompt.to_lowercase();
    for marker in ["corrects:", "corrects=", "fixes:", "fixes=", "corrige:", "corrigir:"] {
        if let Some(index) = lower.find(marker) {
            let rest = prompt[index + marker.len()..].trim();
            let token: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

fn resolve_key(title: &str, prompt: &str, corrects: Option<&str>, siblings: &[Sibling]) -> String {
    if let Some(token) = explicit_token(corrects, prompt) {
        let folded = fingerprint(&token);
        if let Some(hit) = siblings.iter().find(|s| {
            s.plan_key.as_deref() == Some(token.as_str())
                || s.id == token
                || s.work_key == token
                || fingerprint(&s.title) == folded
                || s.work_key == folded
        }) {
            return if hit.work_key.is_empty() { fingerprint(&hit.title) } else { hit.work_key.clone() };
        }
    }
    let fp = fingerprint(title);
    if let Some(hit) = siblings.iter().find(|s| {
        let key = if s.work_key.is_empty() { fingerprint(&s.title) } else { s.work_key.clone() };
        key == fp || fingerprint(&s.title) == fp
    }) {
        return if hit.work_key.is_empty() { fp } else { hit.work_key.clone() };
    }
    fp
}

fn siblings_of(conn: &Connection, run_id: &str, except: &str) -> Result<Vec<Sibling>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, IFNULL(plan_key, ''), IFNULL(work_key, ''), status
             FROM tasks WHERE run_id = ?1 AND id <> ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id, except], |row| {
            let plan: String = row.get(2)?;
            Ok(Sibling {
                id: row.get(0)?,
                title: row.get(1)?,
                plan_key: (!plan.is_empty()).then_some(plan),
                work_key: row.get(3)?,
                status: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Registra a task nova no orçamento. Se for a mesma entrega que já estourou o teto,
/// ela nasce falha e escalada — não entra na fila.
pub fn bind_new_task(conn: &Connection, task_id: &str, run_id: &str, title: &str, prompt: &str, corrects: Option<&str>) -> Result<(), String> {
    let siblings = siblings_of(conn, run_id, task_id)?;
    let key = resolve_key(title, prompt, corrects, &siblings);
    let scope = scope_run(run_id);
    let mut ledger = load(conn, &scope, &key)?;
    if ledger.label.is_empty() {
        ledger.label = title.trim().to_string();
    }
    let sibling_failed = siblings.iter().any(|s| {
        let sibling_key = if s.work_key.is_empty() { fingerprint(&s.title) } else { s.work_key.clone() };
        sibling_key == key && s.status == status::FAILED
    });
    let prefixed = has_correction_prefix(title) || has_correction_prefix(first_line(prompt));
    let explicit = explicit_token(corrects, prompt).is_some();
    let already = ledger.rounds > 0 || sibling_failed || matches!(ledger.status.as_str(), "escalated" | "accepted_pending" | "aborted");
    let consume = already && (explicit || prefixed || sibling_failed || ledger.rounds > 0);
    if !consume {
        save(conn, &scope, &key, &ledger)?;
        set_task_fix(conn, task_id, &key, 0, false, "", None)?;
        return Ok(());
    }
    let failure = ledger.failures.last().map(|n| n.reason.clone()).unwrap_or_else(|| {
        "a entrega anterior deste objetivo falhou e foi reaberta".into()
    });
    match open_round(conn, &scope, &key, title, &failure)? {
        Round::Opened { round, full_gate, brief } => {
            set_task_fix(conn, task_id, &key, round, full_gate, "", Some(&brief))?;
        }
        Round::Blocked { message, rounds } => {
            fail_escalated(conn, task_id, &key, &message, rounds)?;
        }
    }
    Ok(())
}

fn first_line(text: &str) -> &str {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("")
}

enum Round {
    Opened { round: i64, full_gate: bool, brief: String },
    Blocked { message: String, rounds: i64 },
}

fn open_round(conn: &Connection, scope: &str, key: &str, label: &str, failure: &str) -> Result<Round, String> {
    let max = max_rounds(conn);
    let mut ledger = load(conn, scope, key)?;
    if ledger.label.is_empty() {
        ledger.label = label.to_string();
    }
    if matches!(ledger.status.as_str(), "aborted" | "accepted_pending") {
        let message = decision_message(&ledger, max);
        return Ok(Round::Blocked { rounds: ledger.rounds, message });
    }
    let at_ceiling = ledger.rounds >= max;
    if at_ceiling && !ledger.extra_granted {
        push_failure(&mut ledger, failure);
        ledger.status = "escalated".into();
        save(conn, scope, key, &ledger)?;
        return Ok(Round::Blocked { rounds: ledger.rounds, message: escalation_message(scope, key, &ledger, max) });
    }
    if at_ceiling && ledger.extra_granted {
        ledger.extra_granted = false;
        ledger.extras_used += 1;
        ledger.status = "open".into();
    }
    ledger.rounds += 1;
    push_failure(&mut ledger, failure);
    ledger.status = "open".into();
    save(conn, scope, key, &ledger)?;
    let full_gate = ledger.rounds >= max;
    let brief = correction_brief(ledger.rounds, max, full_gate, &specific_failure(failure));
    Ok(Round::Opened { round: ledger.rounds, full_gate, brief })
}

fn push_failure(ledger: &mut Ledger, failure: &str) {
    let reason = specific_failure(failure);
    if ledger.failures.last().is_some_and(|note| note.reason == reason) {
        return;
    }
    ledger.failures.push(Note { round: ledger.rounds.max(1), reason });
    if ledger.failures.len() > 8 {
        let extra = ledger.failures.len() - 8;
        ledger.failures.drain(0..extra);
    }
}

pub fn specific_failure(raw: &str) -> String {
    let lines: Vec<&str> = raw.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let interesting: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| {
            let lower = line.to_lowercase();
            lower.contains("fail")
                || lower.contains("error")
                || lower.contains("erro")
                || lower.contains("assert")
                || lower.contains("panic")
                || lower.contains("expected")
                || lower.contains("esperado")
                || lower.contains(".rs:")
                || lower.contains(".ts:")
                || lower.contains(".tsx:")
        })
        .take(8)
        .collect();
    let chosen: Vec<&str> = if interesting.is_empty() { lines.into_iter().take(6).collect() } else { interesting };
    let text = chosen.join("\n");
    let clipped: String = text.chars().take(500).collect();
    if clipped.trim().is_empty() {
        "a entrega falhou sem um motivo específico no relato".into()
    } else {
        clipped
    }
}

pub fn correction_brief(round: i64, max: i64, full_gate: bool, failure: &str) -> String {
    let mut out = format!(
        "Rodada de correção {round} de {max}. Não repita a tentativa anterior.\nO que falhou:\n{failure}\n"
    );
    if full_gate {
        out.push_str(
            "\nEsta é a ÚLTIMA rodada. Ela termina no gate completo, com a suíte inteira, não só no teste afetado. \
Se já existir pull request, `gh pr checks <número> --watch` É o gate: não repita a suíte localmente. \
Sem PR, rode pelo `ags` (registra o resultado e reaproveita um verde da mesma árvore) e anote como passou, \
no resultado ou no task_handoff (tests com status passed):\n\
- ags test run rust\n\
- ags test run tsc\n\
- ags test run frontend\n\
Sem essa evidência a entrega não fecha como verde.\n",
        );
    } else {
        out.push_str("Nesta rodada, `ags test affected` basta. A suíte completa fica para a última rodada e para a integração.\n");
    }
    out
}

pub fn prompt_addon(round: i64, full_gate: bool, failure: &str) -> String {
    let max_label = if full_gate { round } else { round + 1 };
    format!("\n\n## Correção\n{}", correction_brief(round, max_label.max(round), full_gate, &specific_failure(failure)))
}

fn escalation_message(scope: &str, key: &str, ledger: &Ledger, max: i64) -> String {
    let mut failures = String::new();
    if ledger.failures.is_empty() {
        failures.push_str("1. a entrega falhou sem um motivo específico no relato\n");
    } else {
        for (index, note) in ledger.failures.iter().enumerate() {
            failures.push_str(&format!("{}. (rodada {}) {}\n", index + 1, note.round, note.reason.replace('\n', " ")));
        }
    }
    format!(
        "[limite de correção] \"{}\" parou depois de {} rodada(s) de correção (teto {max}). Não foi integrada como verde.\n\n\
Motivo das falhas:\n{failures}\n\
Opções:\n\
- aceitar com pendências (não integra como verde): ags fix decide --scope {scope} --work {key} --action accept\n\
- mais uma rodada manual, com a suíte completa: ags fix decide --scope {scope} --work {key} --action extra\n\
- abortar a tarefa: ags fix decide --scope {scope} --work {key} --action abort\n",
        ledger.label, ledger.rounds
    )
}

fn decision_message(ledger: &Ledger, max: i64) -> String {
    match ledger.status.as_str() {
        "accepted_pending" => format!(
            "[limite de correção] \"{}\" foi aceita com pendências depois de {} rodada(s) (teto {max}). Não está verde e não entra na integração.",
            ledger.label, ledger.rounds
        ),
        "aborted" => format!("[limite de correção] \"{}\" foi abortada. Não há outra rodada automática.", ledger.label),
        _ => format!("[limite de correção] \"{}\" já está encerrada.", ledger.label),
    }
}

/// Ainda cabe uma correção automática. O `attempt` da linha não entra: o reroute zera
/// esse número, e o teto tem de continuar valendo.
pub fn can_retry(task: &Task, max_rounds: i64) -> bool {
    task.role.as_deref() == Some(super::types::role::WORKER)
        && task.status == status::FAILED
        && task.session_id.is_some()
        && !task.error.as_deref().is_some_and(|error| error.contains("budget"))
        && !matches!(task.fix_status.as_str(), "escalated" | "accepted_pending" | "aborted")
        && task.fix_round < max_rounds
}

/// O que fazer quando um worker da frota falha. Ignora lead, falta de sessão e erro de orçamento.
pub fn on_worker_failure(conn: &Connection, task: &Task) -> Result<FailureOutcome, String> {
    let max = max_rounds(conn);
    let retry = can_retry(task, max);
    let exhausted = task.role.as_deref() == Some(super::types::role::WORKER)
        && task.status == status::FAILED
        && task.session_id.is_some()
        && !task.error.as_deref().is_some_and(|error| error.contains("budget"))
        && !matches!(task.fix_status.as_str(), "escalated" | "accepted_pending" | "aborted")
        && !retry;
    if !retry && !exhausted {
        return Ok(FailureOutcome::Ignored);
    }
    let key = if task.work_key.is_empty() { fingerprint(&task.title) } else { task.work_key.clone() };
    let scope = scope_run(&task.run_id);
    let failure = task.error.clone().unwrap_or_default();
    if exhausted {
        let mut ledger = load(conn, &scope, &key)?;
        if ledger.label.is_empty() {
            ledger.label = task.title.clone();
        }
        push_failure(&mut ledger, &failure);
        ledger.rounds = ledger.rounds.max(task.fix_round);
        ledger.status = "escalated".into();
        save(conn, &scope, &key, &ledger)?;
        let message = escalation_message(&scope, &key, &ledger, max);
        stamp_escalation(conn, &task.id, &key, &message)?;
        record_span(conn, &task.run_id, &task.title, &key, ledger.rounds, true, true)?;
        return Ok(FailureOutcome::Escalated { message, rounds: ledger.rounds });
    }
    match open_round(conn, &scope, &key, &task.title, &failure)? {
        Round::Opened { round, full_gate, brief } => {
            requeue(conn, &task.id, &key, &brief, round, full_gate)?;
            record_span(conn, &task.run_id, &task.title, &key, round, full_gate, false)?;
            Ok(FailureOutcome::Retried { round, full_gate })
        }
        Round::Blocked { message, rounds } => {
            stamp_escalation(conn, &task.id, &key, &message)?;
            record_span(conn, &task.run_id, &task.title, &key, rounds, true, true)?;
            Ok(FailureOutcome::Escalated { message, rounds })
        }
    }
}

/// Reroute de uma entrega que já estourou o teto não volta para a fila.
pub fn block_reroute(conn: &Connection, task: &Task) -> Result<Option<String>, String> {
    if task.status != status::FAILED {
        return Ok(None);
    }
    if matches!(task.fix_status.as_str(), "accepted_pending" | "aborted") {
        return Ok(Some(format!(
            "[limite de correção] \"{}\" já foi encerrada ({}). Passar para outro worker não reabre a correção.",
            task.title, task.fix_status
        )));
    }
    let max = max_rounds(conn);
    if task.fix_round < max && task.fix_status != "escalated" {
        return Ok(None);
    }
    let key = if task.work_key.is_empty() { fingerprint(&task.title) } else { task.work_key.clone() };
    let scope = scope_run(&task.run_id);
    let mut ledger = load(conn, &scope, &key)?;
    if ledger.label.is_empty() {
        ledger.label = task.title.clone();
    }
    if ledger.extra_granted && ledger.extras_used == 0 {
        return Ok(None);
    }
    ledger.rounds = ledger.rounds.max(task.fix_round);
    ledger.status = "escalated".into();
    if let Some(error) = task.error.as_deref() {
        push_failure(&mut ledger, error);
    }
    save(conn, &scope, &key, &ledger)?;
    let message = escalation_message(&scope, &key, &ledger, max);
    stamp_escalation(conn, &task.id, &key, &message)?;
    Ok(Some(message))
}

#[derive(Clone, Debug)]
pub struct CanvasHit {
    pub work_key: String,
    pub label: String,
    pub failure: String,
}

pub fn classify_canvas(from_role: &str, from_name: &str, to_is_orchestrator: bool, text: &str) -> Option<CanvasHit> {
    if to_is_orchestrator {
        return None;
    }
    let from_qa = is_qa(from_role) || is_qa(from_name);
    let marked = text.lines().any(|line| line.trim_start().starts_with(MARKER));
    let failure_language = has_failure_language(text);
    let counts = marked || (from_qa && failure_language);
    if !counts {
        return None;
    }
    let member = field(text, "member").unwrap_or_else(|| from_name.to_string());
    let branch = field(text, "branch").or_else(|| loose_branch(text));
    let subject = field(text, "subject").unwrap_or_else(|| first_line(text).to_string());
    let work_key = match branch.as_deref() {
        Some(branch) => format!("branch:{}", slugify(&fold(branch))),
        None => format!("member:{}|{}", slugify(&fold(&member)), fingerprint(&subject)),
    };
    let label = branch.unwrap_or_else(|| {
        if subject.is_empty() { member } else { subject }
    });
    Some(CanvasHit { work_key, label, failure: specific_failure(text) })
}

fn is_qa(value: &str) -> bool {
    let folded = fold(value);
    folded == "qa" || folded.starts_with("qa ") || folded.starts_with("qa/") || folded.contains("qa /")
}

fn has_failure_language(text: &str) -> bool {
    let lower = fold(text);
    ["falhou", "failed", "reprov", "devolvid", "nao passou", "não passou", "assertion", "panic", "erro:"]
        .iter()
        .any(|word| lower.contains(&fold(word)))
}

fn field(text: &str, name: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with(MARKER) {
            continue;
        }
        for part in line.split_whitespace().skip(1) {
            let (key, value) = part.split_once('=')?;
            if key.eq_ignore_ascii_case(name) && !value.trim().is_empty() {
                return Some(value.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

fn loose_branch(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let index = lower.find("branch ")?;
    let rest = text[index + "branch ".len()..].trim();
    let token: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(*c, '/' | '_' | '.' | '-')).collect();
    (!token.is_empty()).then_some(token)
}

pub fn apply_canvas(conn: &Connection, mission_id: &str, hit: &CanvasHit, original: &str) -> Result<CanvasOutcome, String> {
    let scope = scope_mission(mission_id);
    match open_round(conn, &scope, &hit.work_key, &hit.label, &hit.failure)? {
        Round::Opened { round, full_gate, brief } => {
            record_span_for_mission(conn, mission_id, &hit.label, &hit.work_key, round, full_gate, false)?;
            let text = format!("{original}\n\n{brief}");
            Ok(CanvasOutcome::Deliver { text, round, full_gate, work_key: hit.work_key.clone() })
        }
        Round::Blocked { message, rounds } => {
            record_span_for_mission(conn, mission_id, &hit.label, &hit.work_key, rounds, true, true)?;
            Ok(CanvasOutcome::Escalated { message, rounds, work_key: hit.work_key.clone() })
        }
    }
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub message: String,
    pub requeue_run: Option<String>,
    pub status: String,
}

pub fn decide(conn: &Connection, scope: &str, work_key: &str, task_id: Option<&str>, action: &str) -> Result<Decision, String> {
    let max = max_rounds(conn);
    let mut ledger = load(conn, scope, work_key)?;
    if ledger.label.is_empty() && ledger.rounds == 0 && ledger.failures.is_empty() {
        return Err(format!("não há correção registrada para {work_key}"));
    }
    let action = action.trim().to_ascii_lowercase();
    match action.as_str() {
        "accept" | "accept_pending" => {
            ledger.status = "accepted_pending".into();
            ledger.extra_granted = false;
            save(conn, scope, work_key, &ledger)?;
            let message = decision_message(&ledger, max);
            if let Some(id) = task_id {
                stamp_status(conn, id, "accepted_pending", None, Some(&message))?;
            }
            Ok(Decision { message, requeue_run: None, status: "accepted_pending".into() })
        }
        "abort" => {
            ledger.status = "aborted".into();
            ledger.extra_granted = false;
            save(conn, scope, work_key, &ledger)?;
            let message = decision_message(&ledger, max);
            if let Some(id) = task_id {
                stamp_status(conn, id, "aborted", Some(status::CANCELLED), Some(&message))?;
            }
            Ok(Decision { message, requeue_run: None, status: "aborted".into() })
        }
        "extra" | "extra_round" => {
            if ledger.status == "aborted" || ledger.status == "accepted_pending" {
                return Err(decision_message(&ledger, max));
            }
            if ledger.extras_used > 0 {
                return Err("a rodada manual extra deste trabalho já foi usada".into());
            }
            ledger.extra_granted = true;
            ledger.status = "escalated".into();
            save(conn, scope, work_key, &ledger)?;
            if let Some(id) = task_id {
                let task = store::task_by_id(conn, id)?.ok_or_else(|| "a tarefa já não existe".to_string())?;
                if matches!(task.status.as_str(), status::RUNNING | status::READY) {
                    return Err("a tarefa ainda está em execução; pare-a antes de abrir a rodada manual".into());
                }
                let failure = ledger.failures.last().map(|n| n.reason.clone()).unwrap_or_else(|| "rodada manual".into());
                match open_round(conn, scope, work_key, &ledger.label, &failure)? {
                    Round::Opened { round, full_gate, brief } => {
                        requeue(conn, id, work_key, &brief, round, full_gate)?;
                        record_span(conn, &task.run_id, &task.title, work_key, round, full_gate, false)?;
                        Ok(Decision {
                            message: format!("Rodada manual {round} aberta para \"{}\". O gate completo é obrigatório.", ledger.label),
                            requeue_run: Some(task.run_id),
                            status: "open".into(),
                        })
                    }
                    Round::Blocked { message, .. } => Err(message),
                }
            } else {
                Ok(Decision {
                    message: format!(
                        "A próxima correção de \"{}\" é a rodada manual e exige a suíte completa. Envie uma única AGS-CORRECTION ao integrante.",
                        ledger.label
                    ),
                    requeue_run: None,
                    status: "escalated".into(),
                })
            }
        }
        _ => Err("ação desconhecida: use accept, extra ou abort".into()),
    }
}

pub fn list_scope(conn: &Connection, scope: &str) -> Result<Vec<FixView>, String> {
    let max = max_rounds(conn);
    let mut stmt = conn
        .prepare(
            "SELECT work_key, rounds, failures_json, status, label FROM fix_rounds WHERE scope = ?1 ORDER BY updated_at, work_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([scope], |row| {
            let failures: String = row.get(2)?;
            let rounds: i64 = row.get(1)?;
            Ok(FixView {
                scope: scope.to_string(),
                work_key: row.get(0)?,
                rounds,
                failures: notes_from(&failures).into_iter().map(|note| note.reason).collect(),
                status: row.get(3)?,
                label: row.get(4)?,
                max_rounds: max,
                full_gate: rounds >= max && rounds > 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn full_gate_satisfied(result: &str, handoff: Option<&super::handoff::StructuredHandoff>) -> bool {
    use super::handoff::TestStatus;
    let mut passed = Vec::new();
    if let Some(handoff) = handoff {
        for test in &handoff.tests {
            match test.status {
                TestStatus::Failed => return false,
                TestStatus::Passed => passed.push(test.command.to_lowercase()),
                TestStatus::NotRun => {}
            }
        }
    }
    let blob = format!("{}\n{}", result.to_lowercase(), passed.join("\n"));
    let ci = blob.contains("gh pr checks")
        && (blob.contains("pass") || blob.contains("success") || blob.contains("verde") || blob.contains("ok"));
    if ci {
        return true;
    }
    let rust = (blob.contains("cargo test") && (blob.contains("--lib") || blob.contains("--bin ags") || blob.contains("bin ags")))
        || blob.contains("ags test run rust");
    let tsc = blob.contains("tsc") || blob.contains("ags test run tsc");
    let vitest = blob.contains("vitest") || blob.contains("ags test run frontend");
    rust && tsc && vitest
}

pub const MISSING_GATE: &str = "[gate completo] a última rodada de correção terminou sem a suíte completa (gh pr checks verde, ou ags test run rust, tsc e frontend). A entrega não fecha como verde.";

fn load(conn: &Connection, scope: &str, key: &str) -> Result<Ledger, String> {
    let row: Option<(i64, String, String, i64, i64, String)> = conn
        .query_row(
            "SELECT rounds, failures_json, status, extra_granted, extras_used, label FROM fix_rounds WHERE scope = ?1 AND work_key = ?2",
            params![scope, key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match row {
        None => Ledger::default(),
        Some((rounds, failures, status, extra_granted, extras_used, label)) => Ledger {
            rounds,
            failures: notes_from(&failures),
            status,
            extra_granted: extra_granted != 0,
            extras_used,
            label,
        },
    })
}

fn notes_from(raw: &str) -> Vec<Note> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn save(conn: &Connection, scope: &str, key: &str, ledger: &Ledger) -> Result<(), String> {
    let failures = serde_json::to_string(&ledger.failures).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO fix_rounds (scope, work_key, rounds, failures_json, status, extra_granted, extras_used, label, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(scope, work_key) DO UPDATE SET
            rounds = excluded.rounds,
            failures_json = excluded.failures_json,
            status = excluded.status,
            extra_granted = excluded.extra_granted,
            extras_used = excluded.extras_used,
            label = excluded.label,
            updated_at = excluded.updated_at",
        params![
            scope,
            key,
            ledger.rounds,
            failures,
            ledger.status,
            ledger.extra_granted as i64,
            ledger.extras_used,
            ledger.label,
            crate::util::now_ts(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn set_task_fix(conn: &Connection, task_id: &str, key: &str, round: i64, full_gate: bool, fix_status: &str, last_error: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET work_key = ?1, fix_round = ?2, full_gate = ?3, fix_status = ?4, last_error = COALESCE(?5, last_error) WHERE id = ?6",
        params![key, round, full_gate as i64, fix_status, last_error, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn fail_escalated(conn: &Connection, task_id: &str, key: &str, message: &str, round: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET work_key = ?1, status = ?2, error = ?3, fix_status = 'escalated', ended_at = ?4, full_gate = 1, fix_round = ?5 WHERE id = ?6",
        params![key, status::FAILED, message, crate::util::now_ts(), round, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn stamp_escalation(conn: &Connection, task_id: &str, key: &str, message: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET work_key = ?1, error = ?2, fix_status = 'escalated', full_gate = 1 WHERE id = ?3",
        params![key, message, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn stamp_status(conn: &Connection, task_id: &str, fix_status: &str, status_to: Option<&str>, message: Option<&str>) -> Result<(), String> {
    if let Some(next) = status_to {
        conn.execute(
            "UPDATE tasks SET fix_status = ?1, status = ?2, error = COALESCE(?3, error), ended_at = ?4 WHERE id = ?5 AND status NOT IN ('running', 'ready')",
            params![fix_status, next, message, crate::util::now_ts(), task_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE tasks SET fix_status = ?1, error = COALESCE(?2, error) WHERE id = ?3",
            params![fix_status, message, task_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn requeue(conn: &Connection, task_id: &str, key: &str, brief: &str, round: i64, full_gate: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET status = ?1, last_error = ?2, error = NULL, result = NULL, structured_handoff = NULL,
                          ended_at = NULL, session_id = NULL, work_key = ?3, fix_round = ?4, full_gate = ?5, fix_status = ''
         WHERE id = ?6 AND status IN ('failed', 'cancelled')",
        params![status::PENDING, brief, key, round, full_gate as i64, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn record_span(conn: &Connection, run_id: &str, actor: &str, key: &str, round: i64, full_gate: bool, escalated: bool) -> Result<(), String> {
    let mission: Option<Option<String>> = conn
        .query_row("SELECT mission_id FROM runs WHERE id = ?1", [run_id], |row| row.get::<_, Option<String>>(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(mission) = mission.flatten().filter(|id| !id.is_empty()) {
        record_span_for_mission(conn, &mission, actor, key, round, full_gate, escalated)?;
    }
    Ok(())
}

fn record_span_for_mission(conn: &Connection, mission_id: &str, actor: &str, key: &str, round: i64, full_gate: bool, escalated: bool) -> Result<(), String> {
    let now = crate::util::now_ts_ms();
    let detail = format!("n={round};full={};escalated={};key={key}", if full_gate { 1 } else { 0 }, if escalated { 1 } else { 0 });
    let span = crate::missions::timings::NewSpan {
        kind: "fix_round".into(),
        actor: actor.to_string(),
        target: key.to_string(),
        started_ms: now,
        ended_ms: now,
        detail,
    };
    // Sem a missão na base (run avulso) a telemetria fica na própria task.
    let _ = crate::missions::timings::add(conn, mission_id, &span);
    Ok(())
}

#[cfg(test)]
pub fn max_fix_round_from_detail(detail: &str) -> Option<i64> {
    detail.split(';').find_map(|part| part.strip_prefix("n=")?.parse().ok())
}

#[tauri::command]
pub fn run_fix_decide(
    app: tauri::AppHandle,
    scope: String,
    work_key: String,
    action: String,
    task_id: Option<String>,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<Value, String> {
    let decision = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        decide(&conn, &scope, &work_key, task_id.as_deref(), &action)?
    };
    if let Some(run_id) = &decision.requeue_run {
        super::scheduler::tick(&app, run_id);
    }
    Ok(json!({ "status": decision.status, "message": decision.message, "requeued": decision.requeue_run.is_some() }))
}

#[tauri::command]
pub fn run_fix_list(scope: String, db: tauri::State<crate::database::DbConnection>) -> Result<Vec<FixView>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    list_scope(&conn, &scope)
}

pub fn cli(app: &tauri::AppHandle, command: &str, args: &Value) -> Result<Value, String> {
    let db = app.try_state::<crate::database::DbConnection>().ok_or("a base não está disponível")?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    if let Some(task_id) = args.get("taskId").and_then(Value::as_str) {
        if let Some(task) = store::task_by_id(&conn, task_id)? {
            if task.role.as_deref() == Some(super::types::role::WORKER) {
                return Err("só o usuário ou o Orquestrador decide o que fazer depois do teto de correção".into());
            }
        }
    }
    match command {
        "fix.list" => {
            let scope = arg(args, "scope")?;
            Ok(json!(list_scope(&conn, scope)?))
        }
        "fix.decide" => {
            let scope = arg(args, "scope")?;
            let work_key = arg(args, "work").or_else(|_| arg(args, "workKey"))?;
            let action = arg(args, "action")?;
            let task_id = args.get("task").and_then(Value::as_str);
            let decision = decide(&conn, scope, work_key, task_id, action)?;
            let requeue = decision.requeue_run.clone();
            drop(conn);
            if let Some(run_id) = requeue {
                super::scheduler::tick(app, &run_id);
            }
            Ok(json!({ "status": decision.status, "message": decision.message }))
        }
        _ => Err(format!("comando desconhecido: {command}")),
    }
}

fn arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args.get(name).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("falta --{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::store::{self, NewTask};
    use crate::runs::types::{status, Task, TaskOutcome};

    fn db() -> rusqlite::Connection {
        crate::database::test_db()
    }

    fn workspace(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES (?1, ?1, 0, 0)",
            [id],
        )
        .unwrap();
    }

    fn open_run(conn: &Connection) -> crate::runs::types::Run {
        workspace(conn, "w");
        store::create_run(conn, "w", "login", "/tmp").unwrap()
    }

    fn worker(conn: &Connection, run: &str, title: &str) -> Task {
        store::create_task(
            conn,
            &NewTask {
                run_id: run,
                title,
                prompt: "implemente",
                agent_id: "claude-code",
                cwd: "/tmp/proy",
                role: Some(super::super::types::role::WORKER),
                plan_key: Some("api"),
                queued: true,
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn fail(conn: &Connection, task: &Task, error: &str) {
        conn.execute("UPDATE tasks SET status = 'running', session_id = 's' WHERE id = ?1", [&task.id]).unwrap();
        store::finish_task(conn, &task.id, &TaskOutcome::failed(error)).unwrap();
    }

    #[test]
    fn fingerprint_ignores_correction_prefixes_and_accents() {
        assert_eq!(fingerprint("API de login"), fingerprint("Correção: API de login"));
        assert_eq!(fingerprint("API de login"), fingerprint("fix: api de login"));
        assert_eq!(fingerprint("Tela de configuração"), fingerprint("Rodada 2 - Tela de configuracao"));
        assert_ne!(fingerprint("API de login"), fingerprint("Fila de e-mail"));
    }

    #[test]
    fn specific_failure_keeps_the_asserting_line() {
        let text = specific_failure("rodando\nthread panicked at src/login.rs:40: assertion `left == right` failed\nruído");
        assert!(text.contains("src/login.rs:40"));
        assert!(!text.contains("rodando"));
    }

    #[test]
    fn last_round_requires_the_full_gate_and_a_partial_run_does_not_pass() {
        assert!(!full_gate_satisfied("ags test affected passou", None));
        assert!(full_gate_satisfied(
            "rode cargo test --lib --bin ags, npx tsc --noEmit e npx vitest run: passou",
            None,
        ));
        assert!(full_gate_satisfied("gh pr checks 12 --watch: pass", None));
        let brief = correction_brief(2, 2, true, "assertion falhou");
        assert!(brief.contains("ÚLTIMA"));
        assert!(brief.contains("ags test run rust"));
        assert!(brief.contains("assertion falhou"));
        assert!(!correction_brief(1, 2, false, "x").contains("ÚLTIMA"));
    }

    #[test]
    fn canvas_classifier_counts_a_return_and_ignores_the_first_delegation() {
        let first = "Implemente o login na branch feat/login.";
        assert!(classify_canvas("Orquestrador", "Orquestrador", false, first).is_none());
        assert!(classify_canvas("qa", "QA / Tests", true, "AGS-CORRECTION member=Backend branch=feat/login\nFalhou: tsc").is_none());
        let hit = classify_canvas(
            "qa",
            "QA / Tests",
            false,
            "AGS-CORRECTION member=Backend branch=feat/login subject=login\nFalhou: assertion em src/login.ts:12",
        )
        .unwrap();
        assert_eq!(hit.work_key, "branch:feat-login");
        assert!(hit.failure.contains("src/login.ts:12"));
        let again = classify_canvas("QA", "QA", false, "A entrega de Backend, branch feat/login, falhou no vitest").unwrap();
        assert_eq!(again.work_key, hit.work_key);
    }

    #[test]
    fn canvas_stops_at_the_ceiling_and_the_escalation_is_visible() {
        let conn = db();
        workspace(&conn, "w1");
        conn.execute(
            "INSERT INTO missions (id, workspace_id, title, objective, cwd, status, created_at, updated_at) VALUES ('m1','w1','T','o','/tmp','running',0,0)",
            [],
        )
        .unwrap();
        let hit = CanvasHit { work_key: "branch:feat-login".into(), label: "feat/login".into(), failure: "assertion `left == right` failed em src/login.rs:40".into() };
        let first = apply_canvas(&conn, "m1", &hit, "devolva").unwrap();
        match first {
            CanvasOutcome::Deliver { round, full_gate, text, .. } => {
                assert_eq!((round, full_gate), (1, false));
                assert!(text.contains("assertion"));
                assert!(!text.contains("ÚLTIMA"));
            }
            other => panic!("esperava a primeira correção: {other:?}"),
        }
        let second = apply_canvas(&conn, "m1", &hit, "devolva de novo").unwrap();
        match second {
            CanvasOutcome::Deliver { round, full_gate, text, .. } => {
                assert_eq!((round, full_gate), (2, true));
                assert!(text.contains("ags test run rust"));
            }
            other => panic!("esperava a última rodada com gate completo: {other:?}"),
        }
        let third = apply_canvas(&conn, "m1", &hit, "de novo").unwrap();
        match third {
            CanvasOutcome::Escalated { message, rounds, .. } => {
                assert_eq!(rounds, 2);
                assert!(message.contains("[limite de correção]"));
                assert!(message.contains("aceitar com pendências"));
                assert!(message.contains("mais uma rodada manual"));
                assert!(message.contains("abortar"));
                assert!(message.contains("src/login.rs:40"));
                assert!(message.contains("Não foi integrada como verde"));
            }
            other => panic!("esperava escalação: {other:?}"),
        }
        let spans = crate::missions::timings::list(&conn, "m1").unwrap();
        let rounds: Vec<_> = spans.iter().filter(|span| span.kind == "fix_round").collect();
        assert_eq!(rounds.len(), 3);
        assert_eq!(max_fix_round_from_detail(&rounds[1].detail), Some(2));
    }

    #[test]
    fn fleet_stops_at_the_ceiling() {
        let conn = db();
        let run = open_run(&conn);
        let task = worker(&conn, &run.id, "API de login");
        assert_eq!(task.fix_round, 0);
        fail(&conn, &task, "assertion failed em src/login.rs:8");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        let first = on_worker_failure(&conn, &failed).unwrap();
        assert_eq!(first, FailureOutcome::Retried { round: 1, full_gate: false });
        let mid = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        assert_eq!(mid.status, status::PENDING);
        assert!(mid.last_error.unwrap().contains("src/login.rs:8"));
        assert!(!mid.full_gate);

        fail(&conn, &task, "tsc error em src/login.ts:3");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        let second = on_worker_failure(&conn, &failed).unwrap();
        assert_eq!(second, FailureOutcome::Retried { round: 2, full_gate: true });
        assert!(store::task_by_id(&conn, &task.id).unwrap().unwrap().full_gate);

        fail(&conn, &task, "vitest failed Login.spec.ts");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        let third = on_worker_failure(&conn, &failed).unwrap();
        match third {
            FailureOutcome::Escalated { message, rounds } => {
                assert_eq!(rounds, 2);
                assert!(message.contains("Login.spec.ts"));
                assert!(message.contains("--action accept"));
            }
            other => panic!("esperava escalação da frota: {other:?}"),
        }
        let stopped = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        assert_eq!(stopped.status, status::FAILED);
        assert_eq!(stopped.fix_status, "escalated");
        assert_ne!(stopped.status, status::DONE);
    }

    #[test]
    fn counter_survives_reroute_and_task_recreation() {
        let conn = db();
        let run = open_run(&conn);
        let task = worker(&conn, &run.id, "API de login");
        fail(&conn, &task, "cargo test falhou");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        on_worker_failure(&conn, &failed).unwrap();
        let before = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        assert_eq!(before.fix_round, 1);
        assert!(block_reroute(&conn, &before).unwrap().is_none());
        assert!(store::reroute_task(&conn, &task.id, "codex", None, Some("outra"), "manual", None, "nota", true).unwrap());
        let after = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        assert_eq!(after.fix_round, 1, "reroute não zera a rodada");
        assert_eq!(after.work_key, before.work_key);
        let ledger = load(&conn, &scope_run(&run.id), &after.work_key).unwrap();
        assert_eq!(ledger.rounds, 1);

        fail(&conn, &task, "ainda falha o tsc");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        on_worker_failure(&conn, &failed).unwrap();
        let at_ceiling = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        // A segunda correção está na fila (rodada 2). Falha de novo e escala.
        fail(&conn, &task, "vitest failed");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        assert!(matches!(on_worker_failure(&conn, &failed).unwrap(), FailureOutcome::Escalated { .. }));
        let blocked = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        let refusal = block_reroute(&conn, &blocked).unwrap().unwrap();
        assert!(refusal.contains("[limite de correção]"));
        assert_eq!(store::task_by_id(&conn, &task.id).unwrap().unwrap().fix_round, blocked.fix_round);

        let recreated = store::create_task(
            &conn,
            &NewTask {
                run_id: &run.id,
                title: "Correção: API de login",
                prompt: "conserte a API",
                agent_id: "claude-code",
                cwd: "/tmp/proy",
                role: Some(super::super::types::role::WORKER),
                plan_key: Some("api-fix"),
                corrects: Some("api"),
                queued: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(recreated.work_key, blocked.work_key);
        assert_eq!(recreated.fix_round, 2);
        assert_eq!(recreated.status, status::FAILED);
        assert_eq!(recreated.fix_status, "escalated");
        assert!(recreated.error.unwrap().contains("aceitar com pendências"));
        let _ = at_ceiling;
    }

    #[test]
    fn accept_pending_does_not_turn_the_task_green_and_extra_is_once() {
        let conn = db();
        let run = open_run(&conn);
        let task = worker(&conn, &run.id, "API de login");
        fail(&conn, &task, "falhou");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        on_worker_failure(&conn, &failed).unwrap();
        fail(&conn, &task, "falhou de novo");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        on_worker_failure(&conn, &failed).unwrap();
        fail(&conn, &task, "falhou na última");
        let failed = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        on_worker_failure(&conn, &failed).unwrap();
        let stopped = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        let scope = scope_run(&run.id);
        let accepted = decide(&conn, &scope, &stopped.work_key, Some(&stopped.id), "accept").unwrap();
        assert_eq!(accepted.status, "accepted_pending");
        let task = store::task_by_id(&conn, &stopped.id).unwrap().unwrap();
        assert_eq!(task.status, status::FAILED);
        assert_eq!(task.fix_status, "accepted_pending");
        assert!(decide(&conn, &scope, &task.work_key, Some(&task.id), "extra").is_err());
    }

    #[test]
    fn finishing_the_last_round_without_the_full_suite_is_not_green() {
        let conn = db();
        let run = open_run(&conn);
        let task = worker(&conn, &run.id, "API de login");
        conn.execute(
            "UPDATE tasks SET status = 'running', full_gate = 1, fix_round = 2, session_id = 's' WHERE id = ?1",
            [&task.id],
        )
        .unwrap();
        store::finish_task(&conn, &task.id, &TaskOutcome { ok: true, result: Some("ags test affected passou".into()), ..Default::default() }).unwrap();
        let done = store::task_by_id(&conn, &task.id).unwrap().unwrap();
        assert_eq!(done.status, status::FAILED);
        assert!(done.error.unwrap().contains("gate completo"));

        conn.execute("UPDATE tasks SET status = 'running', full_gate = 1 WHERE id = ?1", [&task.id]).unwrap();
        store::finish_task(
            &conn,
            &task.id,
            &TaskOutcome {
                ok: true,
                result: Some("cargo test --lib --bin ags ok; npx tsc --noEmit ok; npx vitest run ok".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(store::task_by_id(&conn, &task.id).unwrap().unwrap().status, status::DONE);
    }

    #[test]
    fn escalated_delivery_cannot_be_merged_as_green() {
        let conn = db();
        let run = open_run(&conn);
        conn.execute(
            "INSERT INTO missions (id, workspace_id, title, objective, cwd, status, active_run_id, created_at, updated_at)
             VALUES ('m1', 'w', 'T', 'o', '/tmp', 'running', ?1, 0, 0)",
            [&run.id],
        )
        .unwrap();
        let escalated = worker(&conn, &run.id, "API de login");
        conn.execute(
            "UPDATE tasks SET status = 'failed', fix_status = 'escalated', fix_round = 2 WHERE id = ?1",
            [&escalated.id],
        )
        .unwrap();
        let plain = worker(&conn, &run.id, "Fila de e-mail");
        conn.execute("UPDATE tasks SET status = 'failed', fix_round = 0 WHERE id = ?1", [&plain.id]).unwrap();
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        let blocked = crate::missions::review::accept(&db, std::path::Path::new("/tmp"), "m1", &escalated.id).unwrap_err();
        assert!(blocked.contains("não pode ser integrada como verde"), "{blocked}");
        let historical = crate::missions::review::accept(&db, std::path::Path::new("/tmp"), "m1", &plain.id).unwrap_err();
        assert!(!historical.contains("não pode ser integrada como verde"), "{historical}");
    }
}
