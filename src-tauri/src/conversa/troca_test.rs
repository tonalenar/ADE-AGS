use rusqlite::Connection;

use super::handoff::Strategy;
use super::store::{self, Tuning};
use super::troca::{apply_switch, migrate, switch_team_member, Switch};

fn conn() -> Connection {
    let conn = crate::database::test_db();
    store::migrate(&conn).unwrap();
    migrate(&conn).unwrap();
    store::insert_thread(&conn, "t1", "claude-code", "/repo", "Conversa", &Tuning { model: Some("opus".into()), effort: Some("high".into()), access: "plan".into() }, None, 1).unwrap();
    store::set_remote_id(&conn, "t1", "sessao-claude").unwrap();
    conn
}

fn to(agent: &str, access: &str) -> Switch {
    Switch { agent_id: agent.into(), model: Some("gpt-6.1-sol".into()), effort: None, access: access.into(), account_id: None }
}

#[test]
fn a_migracao_e_aditiva_e_roda_duas_vezes() {
    let conn = conn();
    migrate(&conn).unwrap();
    migrate(&conn).unwrap();
}

#[test]
fn trocar_para_um_agente_novo_mantem_a_conversa_e_zera_so_o_que_era_do_outro_motor() {
    let conn = conn();
    let applied = apply_switch(&conn, "t1", &to("codex", "ask"), 100).unwrap();
    let row = &applied.row;
    // a mesma conversa (id, pasta, título), com o agente e o ajuste novos
    assert_eq!((row.id.as_str(), row.cwd.as_str(), row.title.as_str()), ("t1", "/repo", "Conversa"));
    assert_eq!((row.agent_id.as_str(), row.model.as_deref(), row.effort.as_deref(), row.access.as_str()), ("codex", Some("gpt-6.1-sol"), None, "ask"));
    // a sessão nativa e o estado do ai-memory eram do motor antigo
    assert_eq!(row.remote_id, None);
    assert_eq!(row.memory, None);
    assert_eq!(applied.strategy, Strategy::Full);
    assert_eq!((applied.from_agent.as_str(), applied.to_agent.as_str(), applied.access_changed), ("claude-code", "codex", false));
}

#[test]
fn o_plano_que_o_codex_nao_tem_vira_supervisionado_e_o_aviso_diz() {
    let conn = conn();
    let applied = apply_switch(&conn, "t1", &to("codex", "plan"), 100).unwrap();
    assert_eq!(applied.row.access, "ask");
    assert!(applied.access_changed);
}

#[test]
fn o_antigravity_nao_tem_tela_de_aprovacao_e_a_troca_avisa_quando_o_acesso_e_supervisionado() {
    // `agy -p` não pergunta: no modo Supervisionado ele NEGA o que pediria aprovação (ver `agy_map::mode_args`).
    let conn = conn();
    let applied = apply_switch(&conn, "t1", &to("antigravity", "ask"), 100).unwrap();
    assert!(applied.no_approval);
    assert!(super::troca::notice_text(&applied).contains("\"noApproval\":true"));
    // com o acesso que libera o que ele faz, não há o que avisar
    let conn = self::conn();
    assert!(!apply_switch(&conn, "t1", &to("antigravity", "edits"), 100).unwrap().no_approval);
    let conn = self::conn();
    assert!(!apply_switch(&conn, "t1", &to("codex", "ask"), 100).unwrap().no_approval, "o Codex tem tela de aprovação");
}

#[test]
fn a_sessao_antiga_fica_guardada_e_voltar_a_retoma_com_o_resumo_so_do_intervalo() {
    let conn = conn();
    apply_switch(&conn, "t1", &to("codex", "ask"), 100).unwrap();
    store::set_remote_id(&conn, "t1", "sessao-codex").unwrap();
    let back = apply_switch(&conn, "t1", &Switch { agent_id: "claude-code".into(), model: Some("opus".into()), effort: None, access: "ask".into(), account_id: None }, 500).unwrap();
    // volta à sessão do Claude e só o que rolou desde que ele saiu (t=100) vai no resumo
    assert_eq!(back.row.remote_id.as_deref(), Some("sessao-claude"));
    assert_eq!(back.strategy, Strategy::Delta { since_ms: 100 });
    // e a do Codex ficou guardada para a próxima volta
    let again = apply_switch(&conn, "t1", &to("codex", "ask"), 900).unwrap();
    assert_eq!(again.row.remote_id.as_deref(), Some("sessao-codex"));
    assert_eq!(again.strategy, Strategy::Delta { since_ms: 500 });
}

#[test]
fn a_sessao_de_outra_conta_nao_volta_porque_ela_mora_no_perfil_da_conta() {
    let conn = conn();
    conn.execute("UPDATE chat_thread SET account_id = 'conta-a' WHERE id = 't1'", []).unwrap();
    apply_switch(&conn, "t1", &to("codex", "ask"), 100).unwrap();
    let back = apply_switch(&conn, "t1", &Switch { agent_id: "claude-code".into(), model: None, effort: None, access: "ask".into(), account_id: Some("conta-b".into()) }, 200).unwrap();
    assert_eq!(back.row.remote_id, None);
    assert_eq!(back.strategy, Strategy::Full);
    assert_eq!(back.row.account_id.as_deref(), Some("conta-b"));
}

#[test]
fn a_conta_do_agente_antigo_nao_e_levada_para_o_novo() {
    let conn = conn();
    conn.execute("UPDATE chat_thread SET account_id = 'conta-do-claude' WHERE id = 't1'", []).unwrap();
    let applied = apply_switch(&conn, "t1", &to("codex", "ask"), 100).unwrap();
    assert_eq!(applied.row.account_id, None);
}

#[test]
fn recusa_o_mesmo_agente_o_desconhecido_e_o_que_nao_fala_por_protocolo() {
    let conn = conn();
    assert!(apply_switch(&conn, "t1", &to("claude-code", "ask"), 1).unwrap_err().contains("mesmo agente"));
    assert!(apply_switch(&conn, "t1", &to("cursor", "ask"), 1).unwrap_err().contains("protocolo"));
    assert!(apply_switch(&conn, "t1", &to("nao-existe", "ask"), 1).is_err());
    assert!(apply_switch(&conn, "nao-existe", &to("codex", "ask"), 1).is_err());
}

#[test]
fn recusa_com_um_pedido_do_agente_ainda_sem_resposta() {
    let conn = conn();
    store::insert_request(&conn, &store::RequestRow {
        id: "r1".into(), thread_id: "t1".into(), rpc_id: "1".into(), kind: "command".into(), item_id: None, title: "x".into(), detail: String::new(),
        options: serde_json::json!([]), state: "pending".into(), created_at: 1,
    }).unwrap();
    assert!(apply_switch(&conn, "t1", &to("codex", "ask"), 1).unwrap_err().contains("pedido"));
}

#[test]
fn no_time_o_integrante_e_o_orquestrador_trocam_de_agente_com_o_nome_certo() {
    let conn = conn();
    crate::chat_team::store::migrate(&conn).unwrap();
    conn.execute("INSERT INTO chat_team (id, orchestrator, agent_id, label, cwd, title, created_at, updated_at) VALUES ('tm', 'thread:t1', 'claude-code', 'Claude Code', '/repo', '', 1, 1)", []).unwrap();
    conn.execute("INSERT INTO chat_team (id, orchestrator, agent_id, label, cwd, title, created_at, updated_at) VALUES ('tm2', 'thread:outra', 'codex', 'Codex', '/repo', '', 1, 1)", []).unwrap();
    conn.execute("INSERT INTO chat_team_member (team_id, member, agent_id, label, role, policy, created_at, updated_at) VALUES ('tm2', 'thread:t1b', 'claude-code', 'Claude Code · Revisor', 'reviewer', 'ask', 1, 1)", []).unwrap();
    // orquestrador
    let teams = switch_team_member(&conn, "thread:t1", "claude-code", "codex", 5).unwrap();
    assert_eq!(teams, vec!["tm".to_string()]);
    let (agent, label): (String, String) = conn.query_row("SELECT agent_id, label FROM chat_team WHERE id = 'tm'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((agent.as_str(), label.as_str()), ("codex", "Codex"));
    // integrante: o rótulo "Agente · Papel" troca só a parte do agente
    let teams = switch_team_member(&conn, "thread:t1b", "claude-code", "codex", 6).unwrap();
    assert_eq!(teams, vec!["tm2".to_string()]);
    let (agent, label): (String, String) = conn.query_row("SELECT agent_id, label FROM chat_team_member WHERE member = 'thread:t1b'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((agent.as_str(), label.as_str()), ("codex", "Codex · Revisor"));
    // fora de um time, não há o que atualizar
    assert!(switch_team_member(&conn, "thread:solta", "claude-code", "codex", 7).unwrap().is_empty());
}

#[test]
fn o_resumo_vai_na_frente_da_proxima_mensagem_uma_vez_e_so_sai_da_fila_quando_enviada() {
    use std::sync::{Arc, Mutex};

    use super::troca::{before_send, summary_sent};

    let db = Arc::new(Mutex::new(conn()));
    {
        let c = db.lock().unwrap();
        c.execute_batch("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        store::upsert_item(&c, "t1", None, &crate::canal::timeline::Item { text: Some("Crie a rota".into()), ..crate::canal::timeline::Item::new(crate::canal::timeline::ItemKind::User, "u1".into(), Some(10)) }).unwrap();
    }
    // sem troca pendente a mensagem passa intacta
    assert_eq!(before_send(&db, "t1", "oi"), ("oi".to_string(), false));
    // troca: o resumo (DADO) vai na frente, separado por uma linha em branco, com a fala da pessoa no fim
    let applied = { let c = db.lock().unwrap(); apply_switch(&c, "t1", &to("codex", "ask"), 100).unwrap() };
    super::troca::set_pending_for_test(&db, "t1", &applied);
    let (text, carries) = before_send(&db, "t1", "continue de onde parou");
    assert!(carries);
    assert!(text.starts_with("[ADE AGS] Contexto da conversa anterior"), "{text}");
    assert!(text.contains("Pedido original: Crie a rota"));
    assert!(text.ends_with("\n\ncontinue de onde parou"));
    // um envio que falhou não consome o resumo: a próxima tentativa o leva de novo
    assert!(before_send(&db, "t1", "de novo").1);
    summary_sent(&db, "t1");
    assert_eq!(before_send(&db, "t1", "e agora").0, "e agora");
}
