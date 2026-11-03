//! Escopos de escrita (`writeScopes`): os prefixos de caminho que cada tarefa delegada declara que vai
//! tocar. Quando duas tarefas EM ANDAMENTO se sobrepõem, o canvas e o QG avisam. Só aviso: nada é
//! bloqueado, e a tarefa sem escopo declarado não entra na conta (não se adivinha o que ela vai tocar).
//!
//! Onde o escopo é declarado:
//! - na delegação por `ags peer tell`/`ask` (missão em terminais e time do chat), numa linha
//!   `Escopo: src/features/chat/, src-tauri/src/chat_team/` (ver [`parse_line`]);
//! - no plano da frota (`run_plan`), no campo `write_scopes` de cada tarefa; o app grava a mesma linha no
//!   prompt da tarefa ([`prompt_with_scopes`]), e daí em diante as duas fontes se leem igual.
//!
//! O conflito de verdade só aparecia no merge dos worktrees; este aviso o antecipa.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde::Serialize;

/// Quantos escopos uma tarefa declara, no máximo, e o tamanho de cada um.
pub const MAX_SCOPES: usize = 20;
const MAX_SCOPE_CHARS: usize = 200;

/// Os rótulos aceitos no começo da linha (sem acento e sem maiúsculas).
const LABELS: [&str; 6] = ["escopo", "escopos", "escopo de escrita", "write scopes", "writescopes", "write_scopes"];

/// Um prefixo de caminho relativo à raiz do repositório, sem `./`, sem barra no fim e com `/`. `""` é o
/// repositório inteiro (`.` ou `*`). Recusa caminho absoluto e `..`. Pura.
pub fn normalize(raw: &str) -> Result<String, String> {
    let mut path = raw.trim().trim_matches(|c| c == '`' || c == '"' || c == '\'').replace('\\', "/");
    // Um glob de diretório vale pelo prefixo: `src/**`, `src/*` → `src`.
    while let Some(stripped) = path.strip_suffix("/**").or_else(|| path.strip_suffix("/*")).or_else(|| path.strip_suffix("**")) {
        path = stripped.to_string();
    }
    if path == "*" || path == "." || path == "./" {
        return Ok(String::new());
    }
    if path.starts_with('/') || path.chars().nth(1) == Some(':') || path.starts_with("~") {
        return Err(format!("'{raw}' não é relativo ao repositório"));
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.iter().any(|p| *p == "..") {
        return Err(format!("'{raw}' sai do repositório (..)"));
    }
    if parts.iter().any(|p| p.contains('*')) {
        return Err(format!("'{raw}': use um prefixo de pasta ou arquivo, sem curinga no meio"));
    }
    let normal = parts.join("/");
    if normal.chars().count() > MAX_SCOPE_CHARS {
        return Err(format!("'{}…' passa de {MAX_SCOPE_CHARS} caracteres", normal.chars().take(40).collect::<String>()));
    }
    Ok(normal)
}

/// Valida e normaliza a lista do plano, sem repetir. Pura.
pub fn validate(list: &[String]) -> Result<Vec<String>, String> {
    if list.len() > MAX_SCOPES {
        return Err(format!("{} escopos; o máximo é {MAX_SCOPES}", list.len()));
    }
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let scope = normalize(raw)?;
        if !out.contains(&scope) {
            out.push(scope);
        }
    }
    Ok(out)
}

fn fold(text: &str) -> String {
    text.to_lowercase().replace(['é', 'ê'], "e")
}

/// Os escopos de uma linha `Escopo: a, b` (ou `Write scopes:`), separados por vírgula, `;` ou espaço.
/// O que não normaliza fica de fora. `None` = a linha não é de escopo. Pura.
pub fn parse_line(line: &str) -> Option<Vec<String>> {
    let line = line.trim().trim_start_matches(['-', '*', '>']).trim();
    let (label, rest) = line.split_once(':')?;
    let label = fold(label.trim().trim_matches('*'));
    if !LABELS.contains(&label.as_str()) {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for raw in rest.split([',', ';', ' ']).filter(|p| !p.trim().is_empty()) {
        if let Ok(scope) = normalize(raw)
            && !out.contains(&scope)
        {
            out.push(scope);
        }
    }
    Some(out)
}

/// Os escopos declarados num texto (delegação ou prompt): a primeira linha de escopo que houver. Pura.
pub fn parse(text: &str) -> Vec<String> {
    text.lines().find_map(parse_line).unwrap_or_default()
}

/// O prompt de uma tarefa do plano com a linha de escopo, para o worker ver e para a leitura igual à das
/// delegações. Sem escopo, o prompt fica como está. Pura.
pub fn prompt_with_scopes(prompt: &str, scopes: &[String]) -> String {
    if scopes.is_empty() {
        return prompt.to_string();
    }
    let shown: Vec<&str> = scopes.iter().map(|s| if s.is_empty() { "." } else { s.as_str() }).collect();
    format!("{}\n\nEscopo: {}", prompt.trim_end(), shown.join(", "))
}

/// `a` e `b` se sobrepõem: um é o outro ou está dentro dele, por componente (`src/a` não cobre `src/ab`).
/// `""` (o repositório inteiro) cobre tudo. Pura.
pub fn overlap(a: &str, b: &str) -> bool {
    let inside = |outer: &str, inner: &str| outer.is_empty() || inner == outer || inner.strip_prefix(outer).is_some_and(|rest| rest.starts_with('/'));
    inside(a, b) || inside(b, a)
}

/// Uma tarefa em andamento com o que declarou.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scoped {
    /// Quem faz (o nome do integrante ou o título da tarefa da frota).
    pub owner: String,
    /// A tarefa, numa linha (para a tela).
    pub task: String,
    pub scopes: Vec<String>,
}

/// Duas tarefas em andamento que vão tocar o mesmo lugar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlap {
    pub a: String,
    pub a_task: String,
    pub b: String,
    pub b_task: String,
    /// Os lugares em comum: de cada par que se sobrepõe, o mais específico (`.` = o repositório inteiro).
    pub paths: Vec<String>,
}

/// Cada par de tarefas de donos diferentes que se sobrepõe, na ordem em que vieram. Pura.
pub fn overlaps(works: &[Scoped]) -> Vec<Overlap> {
    let mut out = Vec::new();
    for (i, a) in works.iter().enumerate() {
        for b in works.iter().skip(i + 1).filter(|b| b.owner != a.owner) {
            let mut paths: Vec<String> = Vec::new();
            for x in &a.scopes {
                for y in b.scopes.iter().filter(|y| overlap(x, y)) {
                    let deeper = if x.len() >= y.len() { x } else { y };
                    let shown = if deeper.is_empty() { ".".to_string() } else { deeper.clone() };
                    if !paths.contains(&shown) {
                        paths.push(shown);
                    }
                }
            }
            if !paths.is_empty() {
                out.push(Overlap { a: a.owner.clone(), a_task: a.task.clone(), b: b.owner.clone(), b_task: b.task.clone(), paths });
            }
        }
    }
    out
}

/// Uma mensagem entre agentes, como a fila guarda (o que importa aqui).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub kind: String,
    pub to: String,
    pub to_name: String,
    pub from: String,
    pub text: String,
}

/// O que cada integrante tem EM ANDAMENTO, pelas mensagens em ordem: a última delegação com escopo que
/// ele recebeu, até ele entregar (`handoff`, o `ags peer deliver`). Uma delegação nova sem escopo também
/// encerra a anterior (a tarefa mudou e não disse onde). Pura.
pub fn in_progress(messages: &[Message]) -> Vec<Scoped> {
    let mut open: BTreeMap<String, Scoped> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for m in messages {
        if m.kind == "handoff" {
            open.remove(&m.from);
            continue;
        }
        if !matches!(m.kind.as_str(), "tell" | "ask") || m.to.is_empty() {
            continue;
        }
        let scopes = parse(&m.text);
        if scopes.is_empty() {
            // Só uma tarefa nova encerra a anterior: um "ok" ou uma pergunta solta não diz nada do escopo.
            if m.text.lines().any(|l| l.trim_start().starts_with("Tarefa:")) {
                open.remove(&m.to);
            }
            continue;
        }
        let owner = if m.to_name.trim().is_empty() { m.to.clone() } else { m.to_name.clone() };
        if !order.contains(&m.to) {
            order.push(m.to.clone());
        }
        open.insert(m.to.clone(), Scoped { owner, task: crate::peer_queue::store::task_gist(&m.text), scopes });
    }
    order.iter().filter_map(|to| open.get(to).cloned()).collect()
}

/// As mensagens trocadas entre as abas da missão (as que ela registrou), em ordem.
fn mission_messages(conn: &Connection, mission_id: &str) -> Result<Vec<Message>, String> {
    let exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='peer_messages')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT kind, to_tab_id, to_name, from_tab_id, text FROM peer_messages
             WHERE state != 'refused' AND kind IN ('tell','ask','handoff')
               AND to_tab_id IN (SELECT tab_id FROM mission_usage_tabs WHERE mission_id = ?1)
             ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([mission_id], |r| Ok(Message { kind: r.get(0)?, to: r.get::<_, Option<String>>(1)?.unwrap_or_default(), to_name: r.get(2)?, from: r.get(3)?, text: r.get(4)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// As tarefas da frota de um run (ou de todos os runs de uma missão) que ainda vão rodar ou rodam.
fn fleet_work(conn: &Connection, run_id: Option<&str>, mission_id: Option<&str>) -> Result<Vec<Scoped>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.title, t.prompt FROM tasks t JOIN runs r ON r.id = t.run_id
             WHERE t.status IN ('pending','ready','running') AND (?1 IS NULL OR r.id = ?1) AND (?2 IS NULL OR r.mission_id = ?2)
             ORDER BY t.created_at, t.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id, mission_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (title, prompt) = row.map_err(|e| e.to_string())?;
        let scopes = parse(&prompt);
        if !scopes.is_empty() {
            out.push(Scoped { owner: title.clone(), task: title, scopes });
        }
    }
    Ok(out)
}

/// As sobreposições de uma missão: as delegações em andamento nos terminais e as tarefas da frota dela.
pub fn mission_overlaps(conn: &Connection, mission_id: &str) -> Result<Vec<Overlap>, String> {
    let mut works = in_progress(&mission_messages(conn, mission_id)?);
    works.extend(fleet_work(conn, None, Some(mission_id))?);
    Ok(overlaps(&works))
}

/// As sobreposições das tarefas em andamento de um run da frota.
pub fn run_overlaps(conn: &Connection, run_id: &str) -> Result<Vec<Overlap>, String> {
    Ok(overlaps(&fleet_work(conn, Some(run_id), None)?))
}

/// O aviso em texto, para a resposta do `run_plan` e para a CLI. Vazio sem sobreposição. Pura.
pub fn warning_text(found: &[Overlap]) -> String {
    if found.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = found.iter().map(|o| format!("- {} e {}: {}", o.a, o.b, o.paths.join(", "))).collect();
    format!("Aviso: tarefas em andamento com escopos de escrita sobrepostos (só aviso, nada foi bloqueado; combine quem mexe onde ou serialize):\n{}", lines.join("\n"))
}

#[tauri::command]
pub fn mission_scope_overlaps(db: tauri::State<'_, crate::database::DbConnection>, mission_id: String) -> Result<Vec<Overlap>, String> {
    mission_overlaps(&*db.lock().map_err(|e| e.to_string())?, &mission_id)
}

#[cfg(test)]
mod test {
    use super::*;

    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn normaliza_prefixos_e_recusa_o_que_sai_do_repo() {
        assert_eq!(normalize("./src/features/chat/").unwrap(), "src/features/chat");
        assert_eq!(normalize("src\\chat\\**").unwrap(), "src/chat");
        assert_eq!(normalize("`src-tauri/src/chat_team/*`").unwrap(), "src-tauri/src/chat_team");
        assert_eq!(normalize(".").unwrap(), "");
        assert!(normalize("/etc/passwd").is_err());
        assert!(normalize("C:/x").is_err());
        assert!(normalize("src/../../x").is_err());
        assert!(normalize("src/*/test").is_err());
        assert_eq!(validate(&s(&["src/a/", "src/a"])).unwrap(), s(&["src/a"]));
        assert!(validate(&(0..=MAX_SCOPES).map(|n| format!("d{n}")).collect::<Vec<_>>()).is_err());
    }

    #[test]
    fn sobreposicao_e_por_componente_de_caminho() {
        assert!(overlap("src/a", "src/a"));
        assert!(overlap("src/a", "src/a/b.ts"));
        assert!(overlap("src/a/b.ts", "src/a"));
        assert!(!overlap("src/a", "src/ab"), "prefixo de texto não é prefixo de pasta");
        assert!(!overlap("src/a", "src/b"));
        assert!(overlap("", "qualquer/coisa"), "o repositório inteiro cobre tudo");
    }

    #[test]
    fn le_a_linha_de_escopo_da_delegacao() {
        let text = "Tarefa: corrigir o login\nEscopo: src/features/auth/, src-tauri/src/auth.rs\nPrazo: hoje";
        assert_eq!(parse(text), s(&["src/features/auth", "src-tauri/src/auth.rs"]));
        assert_eq!(parse("- **Write scopes**: docs/ ; README.md"), s(&["docs", "README.md"]));
        assert_eq!(parse("Escopos: /abs, ok/"), s(&["ok"]), "o que não normaliza fica de fora");
        assert!(parse("Tarefa: sem escopo").is_empty());
        assert_eq!(prompt_with_scopes("Faça X.", &s(&["src/a", ""])), "Faça X.\n\nEscopo: src/a, .");
        assert_eq!(parse(&prompt_with_scopes("Faça X.", &s(&["src/a"]))), s(&["src/a"]), "ida e volta");
        assert_eq!(prompt_with_scopes("Faça X.", &[]), "Faça X.");
    }

    #[test]
    fn avisa_so_tarefas_em_andamento_de_donos_diferentes() {
        let tell = |to: &str, text: &str| Message { kind: "tell".into(), to: to.into(), to_name: to.to_uppercase(), from: "lead".into(), text: text.into() };
        let deliver = |from: &str| Message { kind: "handoff".into(), to: "lead".into(), to_name: String::new(), from: from.into(), text: "ENTREGA #1".into() };
        let messages = vec![
            tell("ana", "Tarefa: chat\nEscopo: src/features/chat"),
            tell("bia", "Tarefa: chat e sidebar\nEscopo: src/features/chat/team, src/features/sessions"),
            tell("caio", "Tarefa: backend\nEscopo: src-tauri/src"),
            tell("ana", "ok, segue"),
        ];
        let found = overlaps(&in_progress(&messages));
        assert_eq!(found, vec![Overlap { a: "ANA".into(), a_task: "chat".into(), b: "BIA".into(), b_task: "chat e sidebar".into(), paths: s(&["src/features/chat/team"]) }]);
        // Ana entregou: a sobreposição some.
        let mut done = messages.clone();
        done.push(deliver("ana"));
        assert!(overlaps(&in_progress(&done)).is_empty());
        // Uma tarefa nova sem escopo também encerra a anterior.
        let mut changed = messages;
        changed.push(tell("bia", "Tarefa: outra coisa"));
        assert!(overlaps(&in_progress(&changed)).is_empty());
        assert!(warning_text(&[]).is_empty());
        assert!(warning_text(&found).contains("ANA e BIA: src/features/chat/team"));
    }

    #[test]
    fn le_a_frota_e_os_terminais_da_missao_no_banco() {
        let conn = crate::database::test_db();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w', 'w', 0, 0);
             INSERT INTO missions (id, workspace_id, title, objective, cwd, status, created_at, updated_at) VALUES ('m', 'w', 'M', 'o', '/p', 'running', 1, 1);",
        )
        .unwrap();
        let run = crate::runs::store::create_run(&conn, "w", "o", "/p").unwrap();
        conn.execute("UPDATE runs SET mission_id = 'm' WHERE id = ?1", [&run.id]).unwrap();
        for (title, prompt) in [("API", "Faça.\n\nEscopo: src-tauri/src/api"), ("Docs", "Escreva.\n\nEscopo: docs"), ("Mais API", "Escopo: src-tauri/src/api/login.rs")] {
            crate::runs::store::create_task(&conn, &crate::runs::store::NewTask { run_id: &run.id, title, prompt, agent_id: "claude-code", cwd: "/p", queued: true, ..Default::default() }).unwrap();
        }
        let found = run_overlaps(&conn, &run.id).unwrap();
        assert_eq!(found.len(), 1);
        // As tarefas nascem no mesmo milissegundo: a ordem do par não é garantida.
        let mut pair = [found[0].a.as_str(), found[0].b.as_str()];
        pair.sort();
        assert_eq!(pair, ["API", "Mais API"]);
        assert_eq!(mission_overlaps(&conn, "m").unwrap(), found, "sem mensagens, só a frota");
    }
}
