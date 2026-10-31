//! A permissão dos pedidos de aprovação das conversas por protocolo, decidida no BACKEND (etapa 3, parte B).
//! Antes só o React decidia (política do time e regras «Sempre permitir»): com a casca do chat fechada, a
//! conversa em segundo plano ou a janela recarregada, o integrante parava esperando uma resposta que ninguém dava.
//!
//! Na chegada de cada pedido (`on_arrival`, chamado pelos três motores) e na varredura (`sweep`), o backend
//! decide com `chat_team::permission::decide`: a política do integrante, depois as regras da pessoa. Só responde
//! o que essas duas cobrem; o resto fica `pending` para a pessoa. Risco alto nunca é automático. Quem responde
//! fica gravado (`decided_by`: `policy`, `rule:<id>`; a pessoa grava `person`).
//!
//! Decide sobre o pedido INTEIRO (`Subject`, guardado em `chat_request.subject`), não sobre o título, que os
//! motores truncam na primeira linha do comando: uma regra `ls *` não pode liberar `ls\nrm -rf ~`.
//! O texto do pedido é dado não confiável: nada nele cria nem amplia regra, e nenhum comando de CLI/MCP escreve regras.

use rusqlite::Connection;
use serde_json::Value;
use tauri::AppHandle;

use crate::chat_team::model::{Policy, Verdict};
use crate::chat_team::permission::{self, Decision, Kind, Subject};
use crate::chat_team::store as team_store;
use crate::database::DbConnection;

use super::store::{self, RequestRow};
use super::{api, codex_map::Ask};

/// O pedido, antes de saber o agente e a pasta da conversa (isso o `on_arrival` põe).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub kind: Kind,
    pub detail: String,
    pub files: Vec<String>,
}

/// Pura: o pedido do `app-server` do Codex. O comando vem INTEIRO de `params.command` (o título guarda só a
/// primeira linha). Numa edição, os arquivos estão nos itens da edição (`<item>#<n>`); sem eles vale a raiz
/// pedida. `None` = não é uma aprovação (pergunta): é sempre da pessoa.
pub fn draft_codex(method: &str, params: &Value, ask: &Ask) -> Option<Draft> {
    match method {
        "item/commandExecution/requestApproval" => {
            let command = params.get("command").and_then(Value::as_str).unwrap_or(&ask.title);
            Some(Draft { kind: Kind::Command, detail: command.to_string(), files: Vec::new() })
        }
        "item/fileChange/requestApproval" => {
            let files: Vec<String> = Some(ask.title.clone()).filter(|t| !t.is_empty()).into_iter().collect();
            Some(Draft { kind: Kind::Edit, detail: files.join(", "), files })
        }
        _ => None,
    }
}

/// Pura: o pedido `can_use_tool` do Claude. Bash/PowerShell: o comando inteiro de `input.command`; edições: o
/// arquivo; WebFetch/WebSearch: rede; as outras ferramentas contam como comando «Ferramenta: o que» (o nome fica no
/// começo, então uma regra de shell não as casa por engano). Perguntas e a saída do Plano: `None`.
pub fn draft_claude(request: &Value, ask: &Ask) -> Option<Draft> {
    let tool = request.get("tool_name").and_then(Value::as_str)?;
    let input = request.get("input").unwrap_or(&Value::Null);
    match tool {
        "AskUserQuestion" | "ExitPlanMode" => None,
        "Bash" | "PowerShell" => {
            let command = input.get("command").and_then(Value::as_str).unwrap_or(&ask.title);
            Some(Draft { kind: Kind::Command, detail: command.to_string(), files: Vec::new() })
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            let files = vec![ask.title.clone()];
            Some(Draft { kind: Kind::Edit, detail: ask.title.clone(), files })
        }
        "WebFetch" | "WebSearch" | "web_search" => {
            let what = ask.title.strip_prefix(&format!("{tool}: ")).unwrap_or(&ask.title);
            Some(Draft { kind: Kind::Network, detail: what.to_string(), files: Vec::new() })
        }
        _ => Some(Draft { kind: Kind::Command, detail: ask.title.clone(), files: Vec::new() }),
    }
}

/// Pura: o pedido `session/request_permission` do OpenCode. `execute`: o comando inteiro de `rawInput.command`.
pub fn draft_opencode(params: &Value, ask: &Ask) -> Option<Draft> {
    match ask.kind {
        "fileChange" => Some(Draft { kind: Kind::Edit, detail: ask.title.clone(), files: vec![ask.title.clone()] }),
        "command" => {
            let call = params.get("toolCall").unwrap_or(&Value::Null);
            let full = call.pointer("/rawInput/command").and_then(Value::as_str).filter(|_| call.get("kind").and_then(Value::as_str) == Some("execute"));
            Some(Draft { kind: Kind::Command, detail: full.unwrap_or(&ask.title).to_string(), files: Vec::new() })
        }
        _ => None,
    }
}

/// Algum arquivo, seguindo os links simbólicos NO DISCO, cai fora da pasta? O texto do caminho não mostra um link
/// (`proj/link/x` pode ser `/etc/x`): resolve o trecho que existe e confere contra a pasta de verdade. Só olha
/// o que o texto já prova estar dentro; sem como provar (a pasta não existe, erro ao ler), conta como fora.
pub fn symlink_escapes(files: &[String], cwd: &str) -> bool {
    let Ok(base) = std::fs::canonicalize(cwd) else { return true };
    files.iter().any(|file| {
        let resolved = permission::resolve_path(file, Some(cwd));
        if !resolved.known || !resolved.inside {
            return false;
        }
        let mut path = std::path::Path::new(cwd).join(&resolved.rel);
        let mut rest: Vec<std::ffi::OsString> = Vec::new();
        // O trecho que existe é resolvido (com os links); o que ainda não existe vai por cima, como está.
        while !path.exists() {
            match (path.file_name().map(|n| n.to_os_string()), path.parent().map(|p| p.to_path_buf())) {
                (Some(name), Some(parent)) => {
                    rest.push(name);
                    path = parent;
                }
                _ => return true,
            }
        }
        let Ok(mut real) = std::fs::canonicalize(&path) else { return true };
        real.extend(rest.iter().rev());
        !real.starts_with(&base)
    })
}

/// O que o backend decide de um pedido, lendo o time, as regras e o interruptor. Qualquer erro de leitura é
/// `Ask`: falha fechada, a pessoa decide.
pub fn plan(conn: &Connection, thread_id: &str, subject: &Subject) -> Decision {
    let ask = |why: &str| Decision { verdict: Verdict::Ask, by: "person".into(), why: why.into() };
    let me = format!("thread:{thread_id}");
    let (policy, auto_decide): (Option<Policy>, bool) = match team_store::team_of(conn, &me) {
        Ok(None) => (None, true),
        Ok(Some(team)) => match team_store::member(conn, &me) {
            Ok(member) => (member.map(|m| m.policy), team.auto_decide),
            Err(_) => return ask("Não consegui ler o integrante no time."),
        },
        Err(_) => return ask("Não consegui ler o time."),
    };
    match team_store::rules(conn) {
        Ok(rules) => permission::decide(policy, auto_decide, &rules, subject),
        Err(_) => ask("Não consegui ler as regras de permissão."),
    }
}

/// O pedido que o motor acabou de gravar (`pending`), ainda sem ter sido mostrado à tela: guarda o pedido inteiro,
/// decide e, se a política ou uma regra da pessoa cobrem, RESPONDE ao agente. `true` = foi respondido (o motor não
/// mostra o pedido à tela); `false` = fica para a pessoa. Quem chama já registrou o pedido na sessão do motor.
pub fn on_arrival(app: &AppHandle, db: &DbConnection, row: &RequestRow, draft: Option<Draft>) -> bool {
    let Some(draft) = draft else { return false };
    let prepared = {
        let Ok(conn) = db.lock() else { return false };
        let Ok(Some(thread)) = store::thread(&conn, &row.thread_id) else { return false };
        let mut draft = draft;
        // O Codex não manda os arquivos no pedido de edição: estão nos itens da edição (`<item>#<n>`).
        if draft.kind == Kind::Edit && let Some(item_id) = row.item_id.as_deref() {
            let prefix = format!("{item_id}#");
            let edited: Vec<String> = store::items(&conn, &row.thread_id)
                .unwrap_or_default()
                .into_iter()
                .filter(|i| i.id.starts_with(&prefix))
                .filter_map(|i| i.path)
                .collect();
            if !edited.is_empty() {
                draft.detail = edited.join(", ");
                draft.files = edited;
            }
        }
        let mut subject = Subject::new(draft.kind, draft.detail, draft.files, Some(thread.cwd.clone()), &thread.agent_id);
        if subject.kind == Kind::Edit {
            subject.escapes = symlink_escapes(&subject.files, &thread.cwd);
        }
        if let Ok(json) = serde_json::to_string(&subject) {
            let _ = store::set_subject(&conn, &row.id, &json);
        }
        (plan(&conn, &row.thread_id, &subject), subject)
    };
    let (decision, _subject) = prepared;
    respond(app, db, &row.id, &decision)
}

/// Responde ao agente o que a decisão manda (`Allow`/`Deny`) e grava quem decidiu. `false` = nada foi respondido.
fn respond(app: &AppHandle, db: &DbConnection, request_id: &str, decision: &Decision) -> bool {
    let choice = match decision.verdict {
        Verdict::Allow => "allow",
        Verdict::Deny => "deny",
        Verdict::Ask => return false,
    };
    // Se o agente já fechou, `answer_as` falha e o pedido segue pendente (a varredura de órfãos o expira).
    let answered = api::answer_as(app, db, request_id, choice, &decision.by, Some(&decision.why)).unwrap_or(false);
    if answered && let Some(rule_id) = decision.by.strip_prefix("rule:") && let Ok(conn) = db.lock() {
        let _ = team_store::count_rule_use(&conn, rule_id, crate::util::now_ts_ms());
    }
    answered
}

/// Reaplica o decisor aos pedidos `pending` de TODAS as conversas ativas, a partir do pedido inteiro guardado
/// (`subject`). Um pedido sem `subject` (de antes desta versão) nunca é decidido sozinho. Serve ao recarregar da
/// janela, a uma regra nova da pessoa e ao interruptor do time. Idempotente. Devolve quantos respondeu.
pub fn sweep(app: &AppHandle, db: &DbConnection) -> usize {
    let todo: Vec<(String, Decision)> = {
        let Ok(conn) = db.lock() else { return 0 };
        let Ok(pending) = store::pending_all(&conn) else { return 0 };
        pending.iter().filter_map(|row| plan_stored(&conn, row).map(|d| (row.id.clone(), d))).collect()
    };
    todo.iter().filter(|(id, decision)| respond(app, db, id, decision)).count()
}

/// A decisão de um pedido já gravado, pelo `subject` guardado. `None` = sem `subject`, ou a pessoa decide.
pub fn plan_stored(conn: &Connection, row: &RequestRow) -> Option<Decision> {
    if row.kind == "question" {
        return None;
    }
    let subject: Subject = serde_json::from_str(&store::subject_of(conn, &row.id).ok()??).ok()?;
    let decision = plan(conn, &row.thread_id, &subject);
    (decision.verdict != Verdict::Ask).then_some(decision)
}

#[cfg(all(test, unix))]
mod test_links {
    use super::symlink_escapes;

    #[test]
    fn o_link_simbolico_para_fora_da_pasta_conta_como_fora() {
        let root = std::env::temp_dir().join(format!("ags-links-{}", uuid::Uuid::new_v4()));
        let (proj, outside) = (root.join("proj"), root.join("outside"));
        std::fs::create_dir_all(proj.join("src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, proj.join("link")).unwrap();
        let cwd = proj.to_str().unwrap();
        let files = |f: &[&str]| f.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(symlink_escapes(&files(&["link/x.txt"]), cwd), "o link aponta para fora");
        assert!(symlink_escapes(&files(&["src/a.rs", "link/novo/dir/x"]), cwd), "um arquivo que sai basta");
        assert!(!symlink_escapes(&files(&["src/a.rs", "novo/dir/x.rs"]), cwd), "caminho que ainda não existe, sem link");
        assert!(!symlink_escapes(&files(&[&format!("{cwd}/src/a.rs")]), cwd));
        assert!(symlink_escapes(&files(&["a"]), "/nao/existe/mesmo"), "sem como provar a pasta: fora");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
