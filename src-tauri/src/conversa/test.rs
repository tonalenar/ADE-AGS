use serde_json::json;

use crate::canal::timeline::{ItemKind, ToolKind, ToolStatus};

use super::codex_map::{access_policy, answer_of, ask_of, items_of, turn_end};
use super::store::{self, RequestRow, Tuning};

fn thread(conn: &rusqlite::Connection, id: &str) {
    store::insert_thread(conn, id, "codex", "/tmp/p", "Título", &Tuning { model: Some("gpt-6.1-sol".into()), effort: None, access: "ask".into() }, None, 1).unwrap();
}

#[test]
fn a_migracao_roda_duas_vezes_sem_erro() {
    let conn = crate::database::test_db();
    store::migrate(&conn).unwrap();
    store::migrate(&conn).unwrap();
}

#[test]
fn um_item_novo_vai_para_o_fim_e_o_atualizado_fica_no_lugar() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    let mut cmd = items_of(&json!({ "type": "commandExecution", "id": "c1", "command": "ls", "status": "inProgress" }), Some(1)).remove(0);
    store::upsert_item(&conn, "t1", Some("r1"), &items_of(&json!({ "type": "userMessage", "id": "u1", "content": [{ "type": "text", "text": "oi" }] }), None)[0]).unwrap();
    store::upsert_item(&conn, "t1", Some("r1"), &cmd).unwrap();
    store::upsert_item(&conn, "t1", Some("r1"), &items_of(&json!({ "type": "agentMessage", "id": "a1", "text": "pronto" }), None)[0]).unwrap();
    cmd.status = Some(ToolStatus::Done);
    store::upsert_item(&conn, "t1", Some("r1"), &cmd).unwrap();
    let items = store::items(&conn, "t1").unwrap();
    assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["u1", "c1", "a1"]);
    assert_eq!(items[1].status, Some(ToolStatus::Done));
}

#[test]
fn a_conversa_guarda_o_id_do_codex_e_a_troca_de_acesso() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    store::set_remote_id(&conn, "t1", "thr_9").unwrap();
    store::set_tuning(&conn, "t1", &Tuning { model: None, effort: Some("high".into()), access: "full".into() }, 5).unwrap();
    let row = store::thread(&conn, "t1").unwrap().unwrap();
    assert_eq!(row.remote_id.as_deref(), Some("thr_9"));
    assert_eq!((row.model, row.effort.as_deref(), row.access.as_str()), (None, Some("high"), "full"));
}

#[test]
fn os_pedidos_pendentes_expiram_e_nao_se_respondem_duas_vezes() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    let row = |id: &str| RequestRow {
        id: id.into(), thread_id: "t1".into(), rpc_id: "7".into(), kind: "command".into(), item_id: None,
        title: "rm -rf build".into(), detail: String::new(), options: json!([]), state: "pending".into(), created_at: 1,
    };
    store::insert_request(&conn, &row("q1")).unwrap();
    store::insert_request(&conn, &row("q2")).unwrap();
    assert!(store::answer_request(&conn, "q1", "allow", 2).unwrap());
    assert!(!store::answer_request(&conn, "q1", "deny", 3).unwrap());
    assert_eq!(store::expire_requests(&conn, "t1").unwrap(), ["q2"]);
    assert!(store::pending_requests(&conn, "t1").unwrap().is_empty());
}

#[test]
fn apagar_a_conversa_leva_os_itens_junto() {
    let conn = crate::database::test_db();
    thread(&conn, "t1");
    store::upsert_item(&conn, "t1", None, &items_of(&json!({ "type": "agentMessage", "id": "a1", "text": "x" }), None)[0]).unwrap();
    conn.execute("DELETE FROM chat_thread WHERE id = 't1'", []).unwrap();
    assert!(store::items(&conn, "t1").unwrap().is_empty());
}

#[test]
fn a_mensagem_do_usuario_junta_os_textos_e_ignora_imagens() {
    let item = &items_of(&json!({ "type": "userMessage", "id": "u", "content": [
        { "type": "text", "text": "a" }, { "type": "localImage", "path": "/x.png" }, { "type": "text", "text": "b" }
    ] }), None)[0];
    assert_eq!((item.kind, item.text.as_deref()), (ItemKind::User, Some("a\n\nb")));
}

#[test]
fn o_comando_com_saida_diferente_de_zero_vira_erro() {
    let item = &items_of(&json!({ "type": "commandExecution", "id": "c", "command": "cargo test\n--lib", "status": "completed",
        "exitCode": 101, "aggregatedOutput": "falhou", "durationMs": 1200 }), None)[0];
    assert_eq!(item.tool, Some(ToolKind::Command));
    assert_eq!(item.status, Some(ToolStatus::Error));
    assert_eq!(item.label.as_deref(), Some("cargo test"));
    assert_eq!((item.output.as_deref(), item.duration_ms), (Some("falhou"), Some(1200)));
}

#[test]
fn a_edicao_vira_um_item_por_arquivo_com_as_linhas() {
    let items = items_of(&json!({ "type": "fileChange", "id": "f", "status": "completed", "changes": [
        { "path": "src/a.rs", "kind": { "type": "update", "move_path": null }, "diff": "--- a\n+++ b\n@@ -1 +1,2 @@\n-x\n+y\n+z" },
        { "path": "src/novo.rs", "kind": { "type": "add" }, "diff": "linha 1\nlinha 2\nlinha 3" },
    ] }), None);
    assert_eq!(items.len(), 2);
    assert_eq!((items[0].id.as_str(), items[0].tool, items[0].added, items[0].removed), ("f#0", Some(ToolKind::Edit), Some(2), Some(1)));
    assert_eq!((items[1].tool, items[1].path.as_deref(), items[1].added), (Some(ToolKind::Write), Some("src/novo.rs"), Some(3)));
}

#[test]
fn o_que_a_timeline_nao_mostra_nao_vira_item() {
    assert!(items_of(&json!({ "type": "reasoning", "id": "r", "summary": [], "content": [] }), None).is_empty());
    assert!(items_of(&json!({ "type": "agentMessage", "id": "a", "text": "  " }), None).is_empty());
    assert!(items_of(&json!({ "type": "agentMessage", "text": "sem id" }), None).is_empty());
}

#[test]
fn o_fim_do_turno_diz_se_foi_interrompido() {
    assert!(turn_end(&json!({ "id": "t", "status": "inProgress" }), None).is_none());
    let end = turn_end(&json!({ "id": "t", "status": "interrupted", "durationMs": 900 }), None).unwrap();
    assert_eq!((end.kind, end.id.as_str(), end.interrupted, end.duration_ms), (ItemKind::TurnEnd, "end:t", Some(true), Some(900)));
    let failed = turn_end(&json!({ "id": "t", "status": "failed", "error": { "message": "sem cota" } }), None).unwrap();
    assert_eq!(failed.text.as_deref(), Some("sem cota"));
}

#[test]
fn o_acesso_vira_politica_e_sandbox_do_codex() {
    assert_eq!(access_policy("ask"), ("untrusted", "workspace-write"));
    assert_eq!(access_policy("safe"), ("on-request", "workspace-write"));
    assert_eq!(access_policy("full"), ("never", "danger-full-access"));
    assert_eq!(access_policy("lixo"), ("untrusted", "workspace-write"));
}

#[test]
fn os_pedidos_de_aprovacao_e_pergunta_viram_o_que_mostrar() {
    let cmd = ask_of("item/commandExecution/requestApproval", &json!({ "itemId": "c", "command": "rm -rf build", "reason": "limpar" })).unwrap();
    assert_eq!((cmd.kind, cmd.title.as_str(), cmd.detail.as_str()), ("command", "rm -rf build", "limpar"));
    let q = ask_of("item/tool/requestUserInput", &json!({ "itemId": "q", "questions": [
        { "id": "q1", "header": "", "question": "Qual banco?", "isOther": false, "isSecret": false, "options": [{ "label": "SQLite", "description": "" }] }
    ] })).unwrap();
    assert_eq!((q.kind, q.title.as_str()), ("question", "Qual banco?"));
    assert_eq!(q.options, json!([{ "id": "q1", "question": "Qual banco?", "options": ["SQLite"] }]));
    assert!(ask_of("attestation/generate", &json!({})).is_none());
}

#[test]
fn a_resposta_sai_no_formato_do_protocolo() {
    assert_eq!(answer_of("command", "allow", &json!([])), json!({ "decision": "accept" }));
    assert_eq!(answer_of("fileChange", "allowSession", &json!([])), json!({ "decision": "acceptForSession" }));
    assert_eq!(answer_of("command", "deny", &json!([])), json!({ "decision": "decline" }));
    assert_eq!(answer_of("question", "SQLite", &json!([{ "id": "q1" }])), json!({ "answers": { "q1": { "answers": ["SQLite"] } } }));
}
