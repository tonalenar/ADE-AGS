use super::pool::*;
use crate::canal::timeline::{Item, ItemKind};
use crate::runs::failure::FailureKind;

fn input<'a>(mode: Mode, history: &'a [i64]) -> Input<'a> {
    Input { mode, kind: FailureKind::RateLimited, bound_to_pool: true, switched_this_turn: false, history, now: 10_000, next: Ok(Some("b".into())) }
}

#[test]
fn desligado_nunca_troca() {
    assert_eq!(decide(input(Mode::Off, &[])), Decision::Skip);
}

#[test]
fn so_o_limite_aciona() {
    for kind in [FailureKind::AuthExpired, FailureKind::Other, FailureKind::ModelUnavailable] {
        assert_eq!(decide(Input { kind, ..input(Mode::Auto, &[]) }), Decision::Skip);
    }
}

#[test]
fn sem_pool_nao_troca() {
    assert_eq!(decide(Input { bound_to_pool: false, ..input(Mode::Auto, &[]) }), Decision::Skip);
}

#[test]
fn automatico_troca_e_perguntar_pergunta() {
    assert_eq!(decide(input(Mode::Auto, &[])), Decision::Switch { to: Some("b".into()) });
    assert_eq!(decide(input(Mode::Ask, &[])), Decision::Ask { to: Some("b".into()) });
}

#[test]
fn a_conta_principal_e_destino_valido() {
    assert_eq!(decide(Input { next: Ok(None), ..input(Mode::Auto, &[]) }), Decision::Switch { to: None });
}

#[test]
fn nao_encadeia_no_mesmo_turno() {
    assert!(matches!(decide(Input { switched_this_turn: true, ..input(Mode::Auto, &[]) }), Decision::Blocked(_)));
}

#[test]
fn teto_de_tres_trocas_por_hora() {
    let h = [9_000, 9_100, 9_200];
    assert!(matches!(decide(input(Mode::Auto, &h)), Decision::Blocked(_)));
    // as velhas (mais de uma hora) não contam
    let old = [1_000, 2_000, 3_000];
    assert_eq!(decide(input(Mode::Auto, &old)), Decision::Switch { to: Some("b".into()) });
}

#[test]
fn sem_alternativa_avisa_o_motivo() {
    assert_eq!(
        decide(Input { next: Err("nenhuma conta".into()), ..input(Mode::Auto, &[]) }),
        Decision::Blocked("nenhuma conta".into())
    );
}

#[test]
fn renovacao_le_a_hora_da_mensagem() {
    // 11:34 locais (UTC-3) = 14:34Z.
    let now = 1_793_543_640;
    let off = -3 * 3600;
    // 13:10 ainda vai acontecer hoje.
    assert_eq!(reset_at("You've hit your 5-hour limit · resets 1:10pm (America/Bahia)", now, off), now + (3600 + 36 * 60));
    // 11:10 já passou hoje: amanhã.
    assert_eq!(reset_at("resets 11:10am", now, off), now + (23 * 3600 + 36 * 60));
    assert_eq!(reset_at("resets 3pm (America/Bahia)", now, off), now + (3 * 3600 + 26 * 60));
    // 12pm = meio-dia, 12am = meia-noite
    assert_eq!(reset_at("resets 12pm", now, off), now + 26 * 60);
    assert_eq!(reset_at("resets 12am", now, off), now + (12 * 3600 + 26 * 60));
}

#[test]
fn renovacao_sem_hora_vale_cinco_horas() {
    assert_eq!(reset_at("rate limited", 5_000, 0), 5_000 + WINDOW_SECS);
    assert_eq!(reset_at("resets soon", 5_000, 0), 5_000 + WINDOW_SECS);
}

#[test]
fn volta_so_depois_da_renovacao_conhecida() {
    assert!(!can_return(None, 100));
    assert!(!can_return(Some(200), 100));
    assert!(can_return(Some(100), 100));
}

#[test]
fn recentes_descarta_as_velhas() {
    assert_eq!(recent(&[1, 5_000, 9_000], 10_000), vec![9_000]);
}

fn msg(kind: ItemKind, text: &str) -> Item {
    Item { text: Some(text.into()), ..Item::new(kind, format!("i{text}"), None) }
}

#[test]
fn handoff_leva_as_falas_e_o_pedido_como_dado() {
    let items = vec![msg(ItemKind::User, "faça A"), msg(ItemKind::Assistant, "feito A"), msg(ItemKind::Tool, "ignora")];
    let text = handoff_text(&items, Some("agora B"));
    assert!(text.contains("faça A") && text.contains("feito A") && text.contains("agora B"));
    assert!(!text.contains("ignora"));
    assert!(text.to_lowercase().contains("dado"));
}

#[test]
fn handoff_so_guarda_o_fim_da_conversa() {
    let items: Vec<Item> = (0..40).map(|i| msg(ItemKind::User, &format!("fala-{i:02}"))).collect();
    let text = handoff_text(&items, None);
    assert!(text.contains("fala-39") && !text.contains("fala-00"));
}

fn db_with_thread() -> crate::database::DbConnection {
    let conn = crate::database::test_db();
    super::store::migrate(&conn).unwrap();
    let tuning = super::store::Tuning { model: None, effort: None, access: "ask".into() };
    super::store::insert_thread(&conn, "t1", "claude-code", "/tmp/p", "Título", &tuning, Some("a"), 1).unwrap();
    super::store::set_remote_id(&conn, "t1", "sessao-da-conta-a").unwrap();
    std::sync::Arc::new(std::sync::Mutex::new(conn))
}

#[test]
fn a_troca_passa_a_conta_esquece_a_sessao_e_guarda_a_origem() {
    let db = db_with_thread();
    move_account(&db, "t1", &Some("a".into()), &Some("b".into()), 5_000, 1_000).unwrap();
    let row = super::api::thread(&db, "t1").unwrap();
    assert_eq!(row.account_id.as_deref(), Some("b"));
    // a sessão mora no perfil da conta antiga: a nova abre do zero, sem tentar retomar
    assert_eq!(row.remote_id, None);
    // a segunda troca (b → c) não apaga de onde a conversa veio: a volta é para a original
    move_account(&db, "t1", &Some("b".into()), &Some("c".into()), 9_000, 2_000).unwrap();
    let saved = crate::database::get_setting(&db, "chat.pool.switched.t1").unwrap().unwrap();
    let saved: Switched = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved, Switched { origin: Some("a".into()), origin_resets_at: Some(5_000), history: vec![1_000, 2_000] });
}

#[test]
fn a_conversa_so_liga_a_um_pool_quando_a_pessoa_escolhe() {
    let db = db_with_thread();
    assert!(pending(&db, "t1").is_none());
    assert_eq!(mode(&db), Mode::Off);
    crate::database::set_setting(&db, "chat.pool.mode", "auto").unwrap();
    assert_eq!(mode(&db), Mode::Auto);
    crate::database::set_setting(&db, "chat.pool.mode", "qualquer-coisa").unwrap();
    assert_eq!(mode(&db), Mode::Off);
}

fn pool(id: &str, agent: &str, members: &[Option<&str>]) -> crate::accounts::pools::Pool {
    crate::accounts::pools::Pool { id: id.into(), name: format!("Pool {id}"), agent_id: agent.into(), members: members.iter().map(|m| m.map(String::from)).collect(), strategy: Default::default(), failover: false }
}

#[test]
fn oferece_o_pool_que_tem_a_conta_da_conversa() {
    let pools = [pool("p1", "claude", &[None, Some("ton")]), pool("p2", "codex", &[Some("ton"), Some("x")])];
    assert_eq!(offer_pool(&pools, "claude", &Some("ton".into())).map(|p| p.id.as_str()), Some("p1"));
    assert_eq!(offer_pool(&pools, "claude", &None).map(|p| p.id.as_str()), Some("p1"));
}

#[test]
fn nao_oferece_pool_de_outro_agente_ou_sem_a_conta_ou_de_uma_so() {
    let pools = [pool("p2", "codex", &[Some("ton"), Some("x")]), pool("p3", "claude", &[Some("a"), Some("b")]), pool("p4", "claude", &[Some("ton")])];
    assert!(offer_pool(&pools, "claude", &Some("ton".into())).is_none());
}

#[test]
fn o_erro_real_do_claude_e_limite_e_a_hora_sai_do_texto() {
    use crate::runs::failure::{classify, FailureKind};
    let erro = "You've hit your 5-hour limit · resets 1:10pm (America/Bahia)";
    assert_eq!(classify(erro), FailureKind::RateLimited);
    // 2026-11-01 12:51 local (UTC-3 => 15:51 UTC) -> 13:10 do mesmo dia
    let now = 1_793_548_260;
    assert_eq!(reset_at(erro, now, -3 * 3600) - now, 19 * 60);
}

#[test]
fn a_linha_result_do_claude_vira_erro_de_limite() {
    use crate::conversa::claude_map::{Mapper, Out};
    let line = serde_json::json!({ "type": "result", "subtype": "success", "is_error": true, "result": "You've hit your 5-hour limit · resets 1:10pm (America/Bahia)", "duration_ms": 900 });
    let out = Mapper::default().feed(&line, 0);
    let Some(Out::Done(r)) = out.into_iter().next() else { panic!("esperava Done") };
    assert_eq!(crate::runs::failure::classify(&r.error.unwrap()), crate::runs::failure::FailureKind::RateLimited);
}

#[test]
fn troca_manual_so_entre_turnos_sem_pedido_e_para_conta_do_agente() {
    let a = Some("a".to_string());
    let b = Some("b".to_string());
    assert!(check_manual_switch(false, 0, &a, &b, Some("claude-code"), "claude-code").is_ok());
    assert!(check_manual_switch(false, 0, &a, &None, None, "claude-code").is_ok(), "a principal é sempre do agente");
    assert!(check_manual_switch(true, 0, &a, &b, Some("claude-code"), "claude-code").is_err(), "turno em andamento");
    assert!(check_manual_switch(false, 1, &a, &b, Some("claude-code"), "claude-code").is_err(), "pedido pendente");
    assert!(check_manual_switch(false, 0, &a, &a, Some("claude-code"), "claude-code").is_err(), "mesma conta");
    assert!(check_manual_switch(false, 0, &a, &b, Some("codex"), "claude-code").is_err(), "conta de outro agente");
    assert!(check_manual_switch(false, 0, &a, &b, None, "claude-code").is_err(), "conta que não existe");
}

fn db_with_accounts() -> crate::database::DbConnection {
    let db = db_with_thread();
    {
        let conn = db.lock().unwrap();
        conn.execute_batch(
            "INSERT INTO agent_accounts (id, agent_id, name, dir, created_at) VALUES ('a','claude-code','Ton','/d/a',1), ('b','claude-code','Erist','/d/b',1), ('x','codex','Outra','/d/x',1);",
        )
        .unwrap();
    }
    db
}

#[test]
fn troca_manual_passa_a_conta_zera_a_sessao_e_nao_mexe_no_pool() {
    let db = db_with_accounts();
    let (from, to) = set_account_manual(&db, "t1", &Some("b".into()), false, 1_000).unwrap();
    assert_eq!((from, to), (Some("a".to_string()), Some("b".to_string())));
    let row = super::api::thread(&db, "t1").unwrap();
    assert_eq!(row.account_id.as_deref(), Some("b"));
    assert_eq!(row.remote_id, None);
    // escolha da pessoa: não vira «origem» do pool nem gasta o teto de trocas
    assert!(crate::database::get_setting(&db, "chat.pool.switched.t1").unwrap().unwrap_or_default().is_empty());
}

#[test]
fn troca_manual_recusa_conta_de_outro_agente_e_turno_em_andamento() {
    let db = db_with_accounts();
    assert!(set_account_manual(&db, "t1", &Some("x".into()), false, 1_000).is_err());
    assert!(set_account_manual(&db, "t1", &Some("b".into()), true, 1_000).is_err());
    assert_eq!(super::api::thread(&db, "t1").unwrap().account_id.as_deref(), Some("a"));
}

#[test]
fn o_resumo_da_troca_manual_vai_uma_vez_com_a_proxima_mensagem() {
    let db = db_with_accounts();
    {
        let conn = db.lock().unwrap();
        super::store::upsert_item(&conn, "t1", None, &msg(ItemKind::User, "faça X")).unwrap();
    }
    set_account_manual(&db, "t1", &Some("b".into()), false, 1_000).unwrap();
    let first = with_manual_handoff(&db, "t1", "e agora?");
    assert!(first.ends_with("e agora?"));
    assert!(first.len() > "e agora?".len(), "leva o resumo à frente");
    assert_eq!(with_manual_handoff(&db, "t1", "de novo"), "de novo");
}
