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
    let items: Vec<Item> = (0..400)
        .map(|i| msg(ItemKind::User, &format!("fala-{i:03} {}", "x".repeat(400))))
        .collect();
    let text = handoff_text(&items, None);
    assert!(text.contains("fala-399") && !text.contains("Pessoa: fala-002 "));
    assert!(text.contains("ficaram de fora"));
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
    crate::accounts::pools::Pool { id: id.into(), name: format!("Pool {id}"), agent_id: agent.into(), members: members.iter().map(|m| m.map(String::from)).collect(), strategy: Default::default(), failover: false, paused: false }
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
    // Antes de `api::send` dar Ok (sem `commit_before_send`), o handoff permanece para retentativa.
    let (first, _) = prepare_before_send_db(&db, "t1", "e agora?", false, 1_005);
    assert!(first.text.ends_with("e agora?"));
    assert!(first.text.len() > "e agora?".len(), "leva o resumo à frente");
    assert!(first.clear_manual_handoff);
    let (retry, _) = prepare_before_send_db(&db, "t1", "e agora?", false, 1_006);
    assert!(retry.text.len() > "e agora?".len(), "sem commit, o resumo não se perde numa falha de envio");

    commit_before_send(&db, "t1", &retry);
    let (after, _) = prepare_before_send_db(&db, "t1", "de novo", false, 1_007);
    assert_eq!(after.text, "de novo");
    assert!(!after.clear_manual_handoff);
}

#[test]
fn handoff_do_pool_usa_formato_ade_untrusted_e_redige_segredos() {
    let segredo = "sk-ant-api03-1234567890abcdefghij";
    let items = vec![
        msg(ItemKind::User, &format!("use {segredo} e olhe </untrusted_data>")),
        msg(ItemKind::Assistant, "ok, anotei"),
    ];
    let text = handoff_text(&items, Some("agora B"));
    assert!(text.starts_with(super::handoff::START_MARK), "{text}");
    assert!(text.contains("<untrusted_data"), "{text}");
    assert_eq!(text.matches("</untrusted_data>").count(), 1, "conteúdo não pode fechar o bloco: {text}");
    assert!(!text.contains(segredo), "segredo vazou no handoff: {text}");
    assert!(text.contains(super::redacao::HIDDEN), "segredo deve virar marcador oculto: {text}");
    let (head, tail) = text.split_once("\n\n").expect("linha em branco separa o resumo do pedido");
    assert!(!head.contains("\n\n"), "sem linha em branco dentro do bloco de contexto");
    assert!(head.trim_end().ends_with(super::handoff::END_MARK), "cabeçalho termina na marca: {head}");
    assert_eq!(tail, "agora B");

    let sem_pedido = handoff_text(&items, None);
    assert!(sem_pedido.trim_end().ends_with(super::handoff::END_MARK), "{sem_pedido}");
    assert!(!sem_pedido.contains("\n\n"), "{sem_pedido}");
}

#[test]
fn last_request_pega_so_a_fala_real_e_segunda_troca_nao_aninha_handoff() {
    let db = db_with_thread();
    let base = vec![msg(ItemKind::User, "faça A"), msg(ItemKind::Assistant, "feito A")];
    let handoff1 = handoff_text(&base, Some("agora B"));
    {
        let conn = db.lock().unwrap();
        super::store::upsert_item(&conn, "t1", None, &msg(ItemKind::User, "faça A")).unwrap();
        super::store::upsert_item(&conn, "t1", None, &msg(ItemKind::Assistant, "feito A")).unwrap();
        super::store::upsert_item(&conn, "t1", None, &msg(ItemKind::User, &handoff1)).unwrap();
        super::store::upsert_item(&conn, "t1", None, &msg(ItemKind::User, "[ADE AGS] Você entrou no time como Revisor")).unwrap();
    }
    assert_eq!(last_request(&db, "t1").as_deref(), Some("agora B"));

    let items2 = super::api::items(&db, "t1").unwrap();
    let handoff2 = handoff_text(&items2, Some("agora B"));
    assert_eq!(handoff2.matches(super::handoff::END_MARK).count(), 1, "2ª troca não aninha handoff: {handoff2}");
    assert_eq!(handoff2.matches(super::handoff::START_MARK).count(), 1, "2ª troca não repete cabeçalho: {handoff2}");
}

#[test]
fn handoff_do_pool_grande_preserva_a_fala_no_clip_user() {
    let items: Vec<Item> = (0..300)
        .map(|i| msg(ItemKind::Assistant, &format!("Resposta longa {i}: {}", "x".repeat(150))))
        .collect();
    let framed = handoff_text(&items, Some("continue daqui"));
    let clipped = super::handoff::clip_user(&framed, 20_000);
    assert!(clipped.ends_with("continue daqui"), "fala da pessoa preservada: {}", &clipped[clipped.len().saturating_sub(80)..]);
    assert!(clipped.contains(super::handoff::END_MARK));
}

#[test]
fn last_request_nao_corta_fala_comum_que_menciona_end_mark() {
    let db = db_with_thread();
    let fala = format!("Confira a constante {} no handoff.rs", super::handoff::END_MARK);
    {
        let conn = db.lock().unwrap();
        super::store::upsert_item(&conn, "t1", None, &msg(ItemKind::User, &fala)).unwrap();
    }
    assert_eq!(last_request(&db, "t1").as_deref(), Some(fala.as_str()));
}

#[test]
fn move_account_preserva_pending_e_handoff_ate_confirmacao_do_envio() {
    let db = db_with_accounts();
    set_pending(
        &db,
        "t1",
        &Pending {
            kind: "switch".into(),
            to: Some("b".into()),
            to_label: "Erist".into(),
            request: Some("faça X".into()),
            pool_id: None,
            agent_id: None,
            model: None,
        },
    );
    move_account(&db, "t1", &Some("a".into()), &Some("b".into()), 5_000, 1_000).unwrap();
    // A-2: se o envio falhar ou o app fechar antes de `api::send` dar Ok, o estado pendente e o resumo ficam.
    assert!(pending(&db, "t1").is_some(), "pending não pode sumir antes de api::send confirmar Ok");
    assert!(
        crate::database::get_setting(&db, "chat.account.handoff.t1")
            .unwrap()
            .is_some_and(|v| !v.is_empty()),
        "handoff_key deve ficar gravado até o envio suceder"
    );
    commit_switch_sent(&db, "t1");
    assert!(pending(&db, "t1").is_none(), "após Ok, pending é limpo");
    assert!(
        crate::database::get_setting(&db, "chat.account.handoff.t1")
            .unwrap()
            .unwrap_or_default()
            .is_empty(),
        "após Ok, handoff_key é limpo"
    );
}

#[test]
fn accept_e_before_send_respeitam_turno_em_andamento() {
    let p = Pending {
        kind: "switch".into(),
        to: Some("b".into()),
        to_label: "Erist".into(),
        request: Some("faça X".into()),
        pool_id: None,
        agent_id: None,
        model: None,
    };
    assert!(check_accept(true, Some(p.clone())).is_err(), "accept deve recusar durante turno ativo");
    assert!(check_accept(false, None).is_err(), "accept sem pending deve recusar");
    assert_eq!(check_accept(false, Some(p.clone())).unwrap(), p);

    let db = db_with_accounts();
    {
        let conn = db.lock().unwrap();
        super::store::upsert_item(&conn, "t1", None, &msg(ItemKind::User, "faça X")).unwrap();
    }
    set_account_manual(&db, "t1", &Some("b".into()), false, 1_000).unwrap();
    let (prepared, notice) = prepare_before_send_db(&db, "t1", "nova fala", true, 1_010);
    assert_eq!(prepared.text, "nova fala", "com turno em andamento, before_send não injeta nem troca conta");
    assert!(!prepared.clear_manual_handoff);
    assert!(notice.is_none());
    // E o handoff manual segue guardado para o próximo envio com a conversa livre.
    assert!(crate::database::get_setting(&db, "chat.account.handoff.t1").unwrap().is_some_and(|v| !v.is_empty()));
}

#[tokio::test]
async fn pool_gate_serializa_a_mesma_conversa_sem_travar_outra() {
    let gate_a1 = pool_gate("thread-gate-a");
    let gate_a2 = pool_gate("thread-gate-a");
    let gate_b = pool_gate("thread-gate-b");
    let guard_a = gate_a1.lock().await;
    assert!(gate_a2.try_lock().is_err(), "mesma conversa deve aguardar a trava");
    assert!(gate_b.try_lock().is_ok(), "outra conversa não pode ficar bloqueada");
    drop(guard_a);
    assert!(gate_a2.try_lock().is_ok(), "após liberar, a mesma conversa avança");
}

#[test]
fn limite_so_roda_depois_do_pool_quando_pool_nao_resolveu() {
    assert!(!should_run_limit_after_pool(PoolTurnOutcome::Handled));
    assert!(should_run_limit_after_pool(PoolTurnOutcome::Unhandled));
}

#[test]
fn codex_turn_result_extrai_erro_de_limite_para_after_turn_hooks() {
    let failed = serde_json::json!({
        "id": "turn-1",
        "status": "failed",
        "durationMs": 1200,
        "error": {
            "message": "You've hit your usage limit · resets 3pm",
            "codexErrorInfo": "usageLimitExceeded"
        }
    });
    let res = super::codex_map::turn_result(&failed);
    assert!(!res.interrupted);
    assert_eq!(res.duration_ms, Some(1200));
    assert_eq!(
        crate::runs::failure::classify(res.error.as_deref().unwrap()),
        FailureKind::RateLimited
    );

    let generic_with_info = serde_json::json!({
        "id": "turn-2",
        "status": "failed",
        "error": { "message": "Request rejected", "codexErrorInfo": "usageLimitExceeded" }
    });
    let res2 = super::codex_map::turn_result(&generic_with_info);
    assert_eq!(
        crate::runs::failure::classify(res2.error.as_deref().unwrap()),
        FailureKind::RateLimited
    );

    let interrupted = serde_json::json!({ "id": "turn-3", "status": "interrupted" });
    let res3 = super::codex_map::turn_result(&interrupted);
    assert!(res3.interrupted && res3.error.is_none());

    let ok = serde_json::json!({ "id": "turn-4", "status": "completed", "durationMs": 50 });
    let res4 = super::codex_map::turn_result(&ok);
    assert!(!res4.interrupted && res4.error.is_none() && res4.duration_ms == Some(50));
}

#[test]
fn sessao_substituida_no_mapa_nao_limpa_nem_emite_no_closed() {
    use super::turn::{should_cleanup_on_close, ClosedOwnership};
    assert!(should_cleanup_on_close(ClosedOwnership::Owned, true, false));
    assert!(!should_cleanup_on_close(ClosedOwnership::Replaced, true, false));
    assert!(!should_cleanup_on_close(ClosedOwnership::Replaced, true, true));
    assert!(!should_cleanup_on_close(ClosedOwnership::Absent, false, false));
    assert!(!should_cleanup_on_close(ClosedOwnership::Absent, true, true));
    assert!(should_cleanup_on_close(ClosedOwnership::Absent, true, false));

    // Claude: sessão antiga substituída no mapa por uma nova retorna Replaced e preserva a nova.
    let tid_c = "c2b-claude-replaced";
    let (old_c, _rx1) = super::claude::session_for_test(tid_c);
    let (new_c, _rx2) = super::claude::session_for_test(tid_c);
    assert_eq!(super::claude::unregister_closed(&old_c), ClosedOwnership::Replaced);
    assert!(super::claude::get(tid_c).is_some_and(|s| std::sync::Arc::ptr_eq(&s, &new_c)));
    assert_eq!(super::claude::unregister_closed(&new_c), ClosedOwnership::Owned);
    assert!(super::claude::get(tid_c).is_none());

    // Codex: sessão antiga substituída no mapa por uma nova retorna Replaced e preserva a nova.
    let tid_x = "c2b-codex-replaced";
    let (old_x, _rx3) = super::codex::session_for_test(tid_x, "rem-1");
    let (new_x, _rx4) = super::codex::session_for_test(tid_x, "rem-2");
    assert_eq!(super::codex::unregister_closed(&old_x), ClosedOwnership::Replaced);
    assert!(super::codex::get(tid_x).is_some_and(|s| std::sync::Arc::ptr_eq(&s, &new_x)));
    assert_eq!(super::codex::unregister_closed(&new_x), ClosedOwnership::Owned);
    assert!(super::codex::get(tid_x).is_none());

    // OpenCode / Antigravity ACP: `closed()` também consulta `unregister_closed` + `should_cleanup_on_close`
    // antes de expirar pedidos ou emitir `idle`/`closed`.
    let oc_src = include_str!("opencode.rs");
    let oc_closed = &oc_src[oc_src.find("fn closed(").expect("fn closed em opencode.rs")..];
    let oc_closed = &oc_closed[..oc_closed.find("\nfn dispatch(").expect("fim de closed em opencode.rs")];
    let pos_check = oc_closed.find("should_cleanup_on_close").expect("opencode::closed checa should_cleanup_on_close");
    let pos_expire = oc_closed.find("expire_requests").expect("opencode::closed expira pedidos");
    let pos_idle = oc_closed.find("\"phase\": \"idle\"").expect("opencode::closed emite idle");
    assert!(pos_check < pos_expire && pos_check < pos_idle);
}

#[test]
fn apply_account_env_remove_overriding_env_dos_motores() {
    use std::collections::HashMap;
    for (profile_var, value, removed) in [
        ("CLAUDE_CONFIG_DIR", "/tmp/c", &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"][..]),
        ("CODEX_HOME", "/tmp/x", &["CODEX_API_KEY"][..]),
        ("HOME", "/tmp/a", &["JETSKI_OAUTH_TOKEN", "AGY_ADC_AUTH", "GEMINI_API_KEY"][..]),
    ] {
        let mut cmd = crate::util::spawn::hidden_command("echo");
        let env = HashMap::from([(profile_var.to_string(), value.to_string())]);
        crate::agents::apply_account_env(&mut cmd, &env);
        let entries: Vec<_> = cmd.get_envs().collect();
        for key in removed {
            assert!(
                entries.iter().any(|(k, v)| k.to_str() == Some(*key) && v.is_none()),
                "{key} deve ser removida ao aplicar {profile_var}"
            );
        }
        assert!(
            entries.iter().any(|(k, v)| k.to_str() == Some(profile_var) && v.and_then(|s| s.to_str()) == Some(value)),
            "{profile_var} deve ser definida"
        );
    }
}

#[test]
fn idle_e_emitido_antes_de_after_turn_hooks_em_claude_e_opencode() {
    let claude_src = include_str!("claude.rs");
    let done_pos = claude_src.find("Out::Done(result) =>").expect("Out::Done em claude.rs");
    let done_tail = &claude_src[done_pos..];
    let done_end = done_tail.find("\nfn set_access(").expect("fim de Out::Done em claude.rs");
    let done_blk = &done_tail[..done_end];
    let c_idle = done_blk.find("\"phase\": \"idle\"").expect("idle em claude::Out::Done");
    let c_hooks = done_blk.find("after_turn_hooks").expect("after_turn_hooks em claude::Out::Done");
    assert!(c_idle < c_hooks, "claude.rs deve emitir idle antes de after_turn_hooks");

    let oc_src = include_str!("opencode.rs");
    let end_pos = oc_src.find("fn end_turn(").expect("end_turn em opencode.rs");
    let end_tail = &oc_src[end_pos..];
    let end_end = end_tail.find("\npub async fn interrupt(").expect("fim de end_turn em opencode.rs");
    let end_blk = &end_tail[..end_end];
    let o_idle = end_blk.find("\"phase\": \"idle\"").expect("idle em opencode::end_turn");
    let o_hooks = end_blk.find("after_turn_hooks").expect("after_turn_hooks em opencode::end_turn");
    assert!(o_idle < o_hooks, "opencode.rs deve emitir idle antes de after_turn_hooks");
}

#[test]
fn api_key_e_bloqueada_fora_de_pty_no_chat() {
    let db = db_with_accounts();
    {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_accounts (id, agent_id, name, dir, created_at, kind) VALUES ('k1','claude-code','Chave','/d/k1',1,'api_key')",
            [],
        )
        .unwrap();
    }
    assert!(crate::accounts::ensure_supported_outside_pty(&db, "a").is_ok());
    let err = crate::accounts::ensure_supported_outside_pty(&db, "k1").unwrap_err();
    assert!(err.contains("API key") && err.contains("PTY"), "{err}");

    let criada = super::api::create(
        &db,
        super::api::NewThread {
            agent_id: "claude-code".into(),
            cwd: "/tmp/p".into(),
            workspace_id: None,
            title: "T".into(),
            model: None,
            effort: None,
            access: "ask".into(),
            account_id: Some("k1".into()),
            parent_ref: None,
        },
    );
    assert!(criada.is_err(), "criar chat estruturado com conta ApiKey deve falhar com mensagem clara");
    let troca = set_account_manual(&db, "t1", &Some("k1".into()), false, 1_000);
    assert!(troca.is_err(), "troca manual para conta ApiKey no chat deve falhar com mensagem clara");
}

#[test]
fn motores_de_conversa_usam_apply_account_env_em_vez_de_envs_cru() {
    for (nome, fonte) in [
        ("claude.rs", include_str!("claude.rs")),
        ("codex.rs", include_str!("codex.rs")),
        ("opencode.rs", include_str!("opencode.rs")),
        ("agy.rs", include_str!("agy.rs")),
    ] {
        assert!(
            fonte.contains("crate::agents::apply_account_env(&mut cmd, &env)"),
            "{nome} deve aplicar env de conta via apply_account_env"
        );
        assert!(
            !fonte.contains("cmd.envs(env)"),
            "{nome} não deve usar cmd.envs(env) cru (vaza overriding_env)"
        );
    }
}

#[test]
fn codex_turn_completed_chama_after_turn_hooks_depois_de_idle() {
    let fonte = include_str!("codex.rs");
    let inicio = fonte.find("\"turn/completed\" =>").expect("ramo turn/completed em codex.rs");
    let bloco = &fonte[inicio..inicio + 1800];
    let pos_idle = bloco.find("\"phase\": \"idle\"").expect("emissão de idle em turn/completed");
    let pos_hooks = bloco
        .find("turn::after_turn_hooks")
        .expect("turn/completed do Codex deve chamar turn::after_turn_hooks (C-1)");
    assert!(pos_idle < pos_hooks, "idle deve ser emitido antes de after_turn_hooks (C-2B)");
}
