//! Testes da Fase 2: recibos idempotentes e fila de efeitos (contrato §11). Sem relógio real: o
//! `agora` é sempre um número passado ao código. O claim concorrente usa duas conexões no mesmo
//! arquivo SQLite temporário.

use rusqlite::Connection;
use serde_json::json;

use super::effects::{self, Claim, Disposition, EffectState, NewEffect, Reconcile};
use super::receipts::{self, Begin, CommandIdentity, ReceiptState, KIND_CHAT_NEW, KIND_CHAT_SEND, KIND_FLEET_DELEGATE, MISMATCH};

fn db() -> Connection {
    crate::database::test_db()
}

fn identity(kind: &str, caller: &str, request: &str, hash: &str) -> CommandIdentity {
    CommandIdentity {
        kind: kind.into(),
        caller_key: caller.into(),
        request_id: request.into(),
        request_hash: hash.into(),
    }
}

fn send_identity(request: &str, hash: &str) -> CommandIdentity {
    identity(KIND_CHAT_SEND, "chat-send:a", request, hash)
}

mod recibos {
    use super::*;

    #[test]
    fn o_migrate_roda_duas_vezes_sem_perder_linhas() {
        let conn = db();
        receipts::begin(&conn, &send_identity("r1", "h1"), "t1", 10).unwrap();
        crate::harness::store::migrate(&conn).unwrap();
        receipts::migrate(&conn).unwrap();
        assert!(receipts::lookup(&conn, KIND_CHAT_SEND, "chat-send:a", "r1").unwrap().is_some());
    }

    #[test]
    fn um_comando_novo_grava_a_intencao_em_prepared() {
        let conn = db();
        let Begin::Created(receipt) = receipts::begin(&conn, &send_identity("r1", "h1"), "t1", 10).unwrap() else {
            panic!("devia criar");
        };
        assert_eq!(receipt.state, ReceiptState::Prepared);
        assert_eq!(receipt.target_ref, "t1");
        assert_eq!(receipt.request_hash, "h1");
        assert_eq!((receipt.created_at, receipt.updated_at), (10, 10));
        assert_eq!(receipt.event_sequence, None);
    }

    #[test]
    fn repetir_o_mesmo_id_e_hash_devolve_o_mesmo_recibo() {
        let conn = db();
        let first = receipts::begin(&conn, &send_identity("r1", "h1"), "t1", 10).unwrap();
        let again = receipts::begin(&conn, &send_identity("r1", "h1"), "t1", 99).unwrap();
        let (Begin::Created(first), Begin::Existing(again)) = (first, again) else {
            panic!("primeiro cria, segundo reaproveita");
        };
        assert_eq!(first, again, "o recibo é o mesmo, sem regravar a hora");
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM harness_command_receipt", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn o_mesmo_id_com_payload_diferente_falha_fechado() {
        let conn = db();
        receipts::begin(&conn, &send_identity("r1", "h1"), "t1", 10).unwrap();
        let error = receipts::begin(&conn, &send_identity("r1", "h2"), "t1", 11).unwrap_err();
        assert_eq!(error, MISMATCH);
        let hash: String = conn.query_row("SELECT request_hash FROM harness_command_receipt", [], |r| r.get(0)).unwrap();
        assert_eq!(hash, "h1", "o recibo gravado não muda");
    }

    #[test]
    fn chamadores_e_tipos_diferentes_nao_colidem() {
        let conn = db();
        receipts::begin(&conn, &send_identity("r1", "h1"), "t1", 10).unwrap();
        let other_caller = identity(KIND_CHAT_SEND, "chat-send:b", "r1", "h2");
        assert!(matches!(receipts::begin(&conn, &other_caller, "t1", 10).unwrap(), Begin::Created(_)));
        let other_kind = identity("chat_interrupt", "chat-send:a", "r1", "h3");
        assert!(matches!(receipts::begin(&conn, &other_kind, "t1", 10).unwrap(), Begin::Created(_)));
    }

    #[test]
    fn a_transicao_so_vale_a_partir_de_um_estado_esperado() {
        let conn = db();
        let id = send_identity("r1", "h1");
        receipts::begin(&conn, &id, "t1", 10).unwrap();
        let go = |from: &[ReceiptState], to| receipts::transition(&conn, &id.kind, &id.caller_key, &id.request_id, from, to, 20).unwrap();
        assert!(!go(&[ReceiptState::Submitting], ReceiptState::Accepted), "prepared não vira accepted direto");
        assert!(go(&[ReceiptState::Prepared, ReceiptState::Retryable], ReceiptState::Submitting));
        assert!(go(&[ReceiptState::Submitting], ReceiptState::Accepted));
        assert!(!go(&[ReceiptState::Submitting], ReceiptState::Retryable), "uma resposta tardia não sobrescreve accepted");
        let receipt = receipts::lookup(&conn, &id.kind, &id.caller_key, &id.request_id).unwrap().unwrap();
        assert_eq!((receipt.state, receipt.updated_at), (ReceiptState::Accepted, 20));
    }

    #[test]
    fn o_resultado_da_aceitacao_fica_no_recibo() {
        let conn = db();
        let id = send_identity("r1", "h1");
        receipts::begin(&conn, &id, "t1", 10).unwrap();
        receipts::set_result(&conn, &id, r#"{"threadId":"t1"}"#, 12).unwrap();
        let receipt = receipts::lookup(&conn, &id.kind, &id.caller_key, &id.request_id).unwrap().unwrap();
        assert_eq!(receipt.result_json.as_deref(), Some(r#"{"threadId":"t1"}"#));
    }

    #[test]
    fn o_hash_do_payload_e_estavel_e_distingue_conteudo() {
        let a = receipts::payload_hash(&json!({ "thread": "t1", "text": "oi" }));
        assert_eq!(a, receipts::payload_hash(&json!({ "thread": "t1", "text": "oi" })));
        assert_ne!(a, receipts::payload_hash(&json!({ "thread": "t1", "text": "oi!" })));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn o_id_do_cliente_e_validado() {
        assert_eq!(receipts::validate_request_id("  abc  ").unwrap(), "abc");
        assert!(receipts::validate_request_id("   ").is_err());
        assert!(receipts::validate_request_id(&"x".repeat(129)).is_err());
        assert!(receipts::validate_request_id("a\nb").is_err());
        assert!(receipts::validate_request_id(&"x".repeat(128)).is_ok());
    }

    #[test]
    fn o_recibo_antigo_de_delegacao_e_lido_e_o_hash_diferente_falha() {
        let conn = db();
        conn.execute(
            "INSERT INTO run_delegation_receipts (caller_key, request_id, request_hash, run_id, task_keys_json, created_at)
             VALUES ('thread:t1', 'd1', 'hd', 'run-9', '[\"a\"]', 5)",
            [],
        )
        .unwrap();
        let found = receipts::lookup(&conn, KIND_FLEET_DELEGATE, "thread:t1", "d1").unwrap().unwrap();
        assert_eq!(found.state, ReceiptState::Accepted);
        assert_eq!(found.target_ref, "run-9");
        assert_eq!(found.result_json.as_deref(), Some("[\"a\"]"));
        let same = identity(KIND_FLEET_DELEGATE, "thread:t1", "d1", "hd");
        assert!(matches!(receipts::begin(&conn, &same, "run-9", 6).unwrap(), Begin::Existing(_)));
        let other = identity(KIND_FLEET_DELEGATE, "thread:t1", "d1", "outro");
        assert_eq!(receipts::begin(&conn, &other, "run-9", 6).unwrap_err(), MISMATCH);
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM harness_command_receipt", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "ler o recibo antigo não o copia");
    }

    #[test]
    fn o_recibo_antigo_de_conversa_filha_e_lido_com_o_estado_de_entrega() {
        let conn = db();
        crate::conversa::store::insert_thread(
            &conn,
            "t1",
            "codex",
            "/p",
            "T",
            &crate::conversa::store::Tuning { model: None, effort: None, access: "ask".into() },
            None,
            1,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_child_receipts (caller_key, request_id, request_hash, thread_id, delivery_state, created_at, updated_at)
             VALUES ('chat-new:x', 'c1', 'hc', 't1', 'unknown', 5, 6)",
            [],
        )
        .unwrap();
        let found = receipts::lookup(&conn, KIND_CHAT_NEW, "chat-new:x", "c1").unwrap().unwrap();
        assert_eq!((found.state, found.target_ref.as_str()), (ReceiptState::Unknown, "t1"));
        let other = identity(KIND_CHAT_NEW, "chat-new:x", "c1", "outro");
        assert_eq!(receipts::begin(&conn, &other, "t1", 7).unwrap_err(), MISMATCH);
    }

    #[test]
    fn a_escrita_dupla_da_delegacao_e_idempotente_e_legivel() {
        let conn = db();
        receipts::mirror_delegation(&conn, "thread:t1", "d1", "hd", "run-9", "[\"a\"]", 5).unwrap();
        receipts::mirror_delegation(&conn, "thread:t1", "d1", "hd", "run-9", "[\"a\"]", 9).unwrap();
        let found = receipts::lookup(&conn, KIND_FLEET_DELEGATE, "thread:t1", "d1").unwrap().unwrap();
        assert_eq!((found.state, found.target_ref.as_str(), found.created_at), (ReceiptState::Accepted, "run-9", 5));
    }

    #[test]
    fn salvar_a_delegacao_grava_o_recibo_antigo_e_o_novo() {
        let conn = db();
        crate::runs::store::save_delegation_receipt(&conn, "thread:t1", "d1", "hd", "run-9", &["a".to_string()]).unwrap();
        let old = crate::runs::store::delegation_receipt(&conn, "thread:t1", "d1").unwrap().unwrap();
        assert_eq!((old.request_hash.as_str(), old.run_id.as_str()), ("hd", "run-9"));
        let new: i64 = conn
            .query_row("SELECT COUNT(*) FROM harness_command_receipt WHERE kind = 'fleet_delegate'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new, 1);
    }
}

fn new_effect<'a>(key: &'a str, retry_safe: bool, receipt: Option<&'a CommandIdentity>) -> NewEffect<'a> {
    NewEffect { kind: "chat_send", dedupe_key: key, target_ref: "t1", retry_safe, max_attempts: 3, causation_event_id: None, receipt }
}

mod efeitos {
    use super::*;

    fn enqueue(conn: &Connection, key: &str, retry_safe: bool) -> i64 {
        effects::enqueue(conn, &new_effect(key, retry_safe, None), 100).unwrap().id
    }

    #[test]
    fn enfileirar_duas_vezes_a_mesma_intencao_devolve_o_mesmo_efeito() {
        let conn = db();
        let first = effects::enqueue(&conn, &new_effect("k1", false, None), 100).unwrap();
        let again = effects::enqueue(&conn, &new_effect("k1", false, None), 200).unwrap();
        assert!(first.created && !again.created);
        assert_eq!(first.id, again.id);
        let effect = effects::get(&conn, first.id).unwrap().unwrap();
        assert_eq!((effect.state, effect.attempts, effect.max_attempts, effect.created_at), (EffectState::Pending, 0, 3, 100));
        assert_eq!(effect.lease_owner, None);
    }

    #[test]
    fn o_claim_da_o_dono_o_prazo_e_conta_a_tentativa() {
        let conn = db();
        let id = enqueue(&conn, "k1", false);
        let Claim::Claimed(effect) = effects::claim(&conn, id, "a", 1_000, 500).unwrap() else { panic!("devia reclamar") };
        assert_eq!(effect.state, EffectState::Running);
        assert_eq!((effect.lease_owner.as_deref(), effect.lease_until, effect.attempts), (Some("a"), Some(1_500), 1));
    }

    #[test]
    fn com_o_lease_vivo_o_segundo_claim_so_ve_o_dono() {
        let conn = db();
        let id = enqueue(&conn, "k1", true);
        effects::claim(&conn, id, "a", 1_000, 500).unwrap();
        assert_eq!(effects::claim(&conn, id, "b", 1_499, 500).unwrap(), Claim::Held { lease_until: 1_500 });
        let effect = effects::get(&conn, id).unwrap().unwrap();
        assert_eq!((effect.lease_owner.as_deref(), effect.attempts), (Some("a"), 1));
    }

    #[test]
    fn claim_de_efeito_inexistente_ou_acabado() {
        let conn = db();
        assert_eq!(effects::claim(&conn, 999, "a", 1, 10).unwrap(), Claim::Missing);
        let id = enqueue(&conn, "k1", false);
        effects::claim(&conn, id, "a", 1, 10).unwrap();
        assert!(effects::complete(&conn, id, "a", 2).unwrap());
        assert_eq!(effects::claim(&conn, id, "b", 3, 10).unwrap(), Claim::Done(EffectState::Completed));
    }

    #[test]
    fn lease_vencido_de_efeito_seguro_e_reclamado_e_o_dono_antigo_e_recusado() {
        let conn = db();
        let id = enqueue(&conn, "k1", true);
        effects::claim(&conn, id, "a", 1_000, 500).unwrap();
        let Claim::Claimed(effect) = effects::claim(&conn, id, "b", 1_500, 500).unwrap() else { panic!("o lease venceu em 1500") };
        assert_eq!((effect.lease_owner.as_deref(), effect.attempts, effect.lease_until), (Some("b"), 2, Some(2_000)));
        assert!(!effects::complete(&conn, id, "a", 1_600).unwrap(), "o dono antigo não conclui por cima");
        assert_eq!(effects::fail(&conn, id, "a", 1_600, Disposition::Permanent, "x").unwrap(), None);
        assert!(effects::complete(&conn, id, "b", 1_700).unwrap());
    }

    #[test]
    fn lease_vencido_de_efeito_de_provider_vira_desfecho_desconhecido_sem_repetir() {
        let conn = db();
        let receipt = send_identity("r1", "h1");
        receipts::begin(&conn, &receipt, "t1", 50).unwrap();
        receipts::transition(&conn, &receipt.kind, &receipt.caller_key, &receipt.request_id, &[ReceiptState::Prepared], ReceiptState::Submitting, 60).unwrap();
        let id = effects::enqueue(&conn, &new_effect("k1", false, Some(&receipt)), 100).unwrap().id;
        effects::claim(&conn, id, "a", 1_000, 500).unwrap();
        let Claim::Unknown(effect) = effects::claim(&conn, id, "b", 2_000, 500).unwrap() else { panic!("não podia reclamar") };
        assert_eq!((effect.state, effect.outcome_unknown, effect.attempts), (EffectState::Failed, true, 1));
        assert_eq!(effect.last_error.as_deref(), Some("outcome_unknown"));
        let stored = receipts::lookup(&conn, &receipt.kind, &receipt.caller_key, &receipt.request_id).unwrap().unwrap();
        assert_eq!(stored.state, ReceiptState::Unknown, "o recibo vai junto, na mesma operação");
        assert_eq!(effects::claim(&conn, id, "c", 3_000, 500).unwrap(), Claim::Done(EffectState::Failed));
    }

    #[test]
    fn so_o_dono_conclui_e_concluir_e_terminal() {
        let conn = db();
        let id = enqueue(&conn, "k1", false);
        effects::claim(&conn, id, "a", 1_000, 500).unwrap();
        assert!(!effects::complete(&conn, id, "intruso", 1_100).unwrap());
        assert!(effects::complete(&conn, id, "a", 1_100).unwrap());
        assert!(!effects::complete(&conn, id, "a", 1_200).unwrap(), "já concluído");
        let effect = effects::get(&conn, id).unwrap().unwrap();
        assert_eq!((effect.state, effect.lease_owner), (EffectState::Completed, None));
    }

    #[test]
    fn estender_o_lease_exige_o_dono() {
        let conn = db();
        let id = enqueue(&conn, "k1", false);
        effects::claim(&conn, id, "a", 1_000, 500).unwrap();
        assert!(!effects::extend_lease(&conn, id, "b", 1_100, 500).unwrap());
        assert!(effects::extend_lease(&conn, id, "a", 1_400, 500).unwrap());
        assert_eq!(effects::get(&conn, id).unwrap().unwrap().lease_until, Some(1_900));
    }

    #[test]
    fn falha_nao_aplicada_volta_a_pending_ate_estourar_as_tentativas() {
        let conn = db();
        let id = enqueue(&conn, "k1", false);
        for round in 1..=2 {
            effects::claim(&conn, id, "a", 1_000 * round, 500).unwrap();
            let state = effects::fail(&conn, id, "a", 1_000 * round + 1, Disposition::NotApplied, "not_sent").unwrap();
            assert_eq!(state, Some(EffectState::Pending), "tentativa {round}");
        }
        effects::claim(&conn, id, "a", 5_000, 500).unwrap();
        let state = effects::fail(&conn, id, "a", 5_001, Disposition::NotApplied, "not_sent").unwrap();
        assert_eq!(state, Some(EffectState::Failed), "a terceira tentativa esgota max_attempts");
        let effect = effects::get(&conn, id).unwrap().unwrap();
        assert_eq!((effect.attempts, effect.outcome_unknown), (3, false));
    }

    #[test]
    fn falha_permanente_e_desconhecida() {
        let conn = db();
        let a = enqueue(&conn, "a", false);
        let b = enqueue(&conn, "b", false);
        effects::claim(&conn, a, "w", 1, 10).unwrap();
        effects::claim(&conn, b, "w", 1, 10).unwrap();
        assert_eq!(effects::fail(&conn, a, "w", 2, Disposition::Permanent, "boom").unwrap(), Some(EffectState::Failed));
        assert_eq!(effects::fail(&conn, b, "w", 2, Disposition::Unknown, "lost").unwrap(), Some(EffectState::Failed));
        assert!(!effects::get(&conn, a).unwrap().unwrap().outcome_unknown);
        assert!(effects::get(&conn, b).unwrap().unwrap().outcome_unknown);
    }

    #[test]
    fn cancelar_um_efeito_em_andamento_recusa_a_conclusao_tardia() {
        let conn = db();
        let id = enqueue(&conn, "k1", false);
        effects::claim(&conn, id, "a", 1_000, 500).unwrap();
        assert!(effects::cancel(&conn, id, 1_100).unwrap());
        assert!(!effects::complete(&conn, id, "a", 1_200).unwrap());
        assert_eq!(effects::get(&conn, id).unwrap().unwrap().state, EffectState::Cancelled);
        assert!(!effects::cancel(&conn, id, 1_300).unwrap(), "cancelar de novo não muda nada");
        let done = enqueue(&conn, "k2", false);
        effects::claim(&conn, done, "a", 1, 10).unwrap();
        effects::complete(&conn, done, "a", 2).unwrap();
        assert!(!effects::cancel(&conn, done, 3).unwrap(), "concluído não se cancela");
    }

    #[test]
    fn o_erro_gravado_e_sanitizado() {
        let conn = db();
        let id = enqueue(&conn, "k1", false);
        effects::claim(&conn, id, "a", 1, 10).unwrap();
        effects::fail(&conn, id, "a", 2, Disposition::Permanent, "falhou com token=abc123 e\nsegunda linha").unwrap();
        let stored = effects::get(&conn, id).unwrap().unwrap().last_error.unwrap();
        assert!(!stored.contains("abc123") && !stored.contains('\n'), "{stored}");
        assert!(stored.contains("[redigido]"), "{stored}");
    }

    #[test]
    fn sanitize_error_limita_redige_e_limpa() {
        assert_eq!(effects::sanitize_error("  a\t b\r\nc  "), "a b c");
        assert_eq!(effects::sanitize_error(&"x ".repeat(300)).chars().count(), 200);
        for secret in ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuv", "Bearer abc.def.ghi", "password=hunter2", "API_KEY=zzz"] {
            let cleaned = effects::sanitize_error(&format!("erro com {secret} no meio"));
            assert!(cleaned.contains("[redigido]"), "{secret} -> {cleaned}");
            assert!(!cleaned.contains("hunter2") && !cleaned.contains("abcdefghijklmnop") && !cleaned.contains("abc.def"), "{cleaned}");
        }
        let long_blob = "QWxhZGRpbjpvcGVuIHNlc2FtZVF1aWNrQnJvd25Gb3hKdW1wcw==";
        assert!(!effects::sanitize_error(&format!("falhou {long_blob}")).contains(long_blob));
        assert_eq!(effects::sanitize_error("o processo caiu (código 1)"), "o processo caiu (código 1)");
    }

    #[test]
    fn claim_next_pega_o_mais_antigo_pronto_e_pula_o_que_tem_dono() {
        let conn = db();
        let first = enqueue(&conn, "k1", false);
        let second = enqueue(&conn, "k2", false);
        let other = effects::enqueue(&conn, &NewEffect { kind: "outro", ..new_effect("k3", false, None) }, 100).unwrap().id;
        assert_eq!(effects::claim_next(&conn, Some("chat_send"), "w1", 1_000, 500).unwrap().unwrap().id, first);
        assert_eq!(effects::claim_next(&conn, Some("chat_send"), "w2", 1_000, 500).unwrap().unwrap().id, second);
        assert!(effects::claim_next(&conn, Some("chat_send"), "w3", 1_000, 500).unwrap().is_none());
        assert_eq!(effects::claim_next(&conn, None, "w3", 1_000, 500).unwrap().unwrap().id, other);
    }

    #[test]
    fn claim_next_nao_reclama_efeito_de_provider_de_lease_vencido() {
        let conn = db();
        let id = enqueue(&conn, "k1", false);
        effects::claim(&conn, id, "a", 1_000, 500).unwrap();
        assert!(effects::claim_next(&conn, None, "b", 9_000, 500).unwrap().is_none());
        let safe = enqueue(&conn, "k2", true);
        effects::claim(&conn, safe, "a", 1_000, 500).unwrap();
        assert_eq!(effects::claim_next(&conn, None, "b", 9_000, 500).unwrap().unwrap().id, safe);
    }

    #[test]
    fn recover_expired_aplica_a_capability_do_adapter_e_nunca_repete_as_cegas() {
        let conn = db();
        let receipt = send_identity("r1", "h1");
        receipts::begin(&conn, &receipt, "t1", 1).unwrap();
        receipts::transition(&conn, &receipt.kind, &receipt.caller_key, &receipt.request_id, &[ReceiptState::Prepared], ReceiptState::Submitting, 2).unwrap();
        let applied = effects::enqueue(&conn, &new_effect("applied", false, Some(&receipt)), 1).unwrap().id;
        let not_applied = enqueue(&conn, "not_applied", false);
        let unknown = enqueue(&conn, "unknown", false);
        let alive = enqueue(&conn, "alive", false);
        for id in [applied, not_applied, unknown] {
            effects::claim(&conn, id, "morto", 1_000, 500).unwrap();
        }
        effects::claim(&conn, alive, "vivo", 1_900, 500).unwrap();
        let mut asked = Vec::new();
        let report = effects::recover_expired(&conn, 2_000, &mut |effect| {
            asked.push(effect.id);
            match effect.id {
                id if id == applied => Reconcile::Applied,
                id if id == not_applied => Reconcile::NotApplied,
                _ => Reconcile::Unknown,
            }
        })
        .unwrap();
        assert_eq!((report.completed, report.requeued, report.unknown), (vec![applied], vec![not_applied], vec![unknown]));
        assert!(!asked.contains(&alive), "lease vivo não é reconciliado");
        assert_eq!(effects::get(&conn, applied).unwrap().unwrap().state, EffectState::Completed);
        let requeued = effects::get(&conn, not_applied).unwrap().unwrap();
        assert_eq!((requeued.state, requeued.lease_owner), (EffectState::Pending, None));
        let lost = effects::get(&conn, unknown).unwrap().unwrap();
        assert_eq!((lost.state, lost.outcome_unknown), (EffectState::Failed, true));
        assert_eq!(effects::get(&conn, alive).unwrap().unwrap().state, EffectState::Running);
        let stored = receipts::lookup(&conn, &receipt.kind, &receipt.caller_key, &receipt.request_id).unwrap().unwrap();
        assert_eq!(stored.state, ReceiptState::Accepted, "Applied conclui o recibo ligado");
    }

    #[test]
    fn a_fila_nao_guarda_payload_nem_texto() {
        let conn = db();
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('harness_effect')")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for forbidden in ["payload", "text", "prompt", "body", "content"] {
            assert!(!columns.iter().any(|c| c == forbidden), "{forbidden} em {columns:?}");
        }
    }
}

mod concorrencia {
    use std::sync::{Arc, Barrier};

    use super::*;

    fn temp_db(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ags-effects-{tag}-{}.db", uuid::Uuid::new_v4().simple()))
    }

    fn open(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        receipts::migrate(&conn).unwrap();
        effects::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn duas_conexoes_nunca_reclamam_o_mesmo_efeito_ao_mesmo_tempo() {
        let path = temp_db("claim");
        let setup = open(&path);
        let ids: Vec<i64> = (0..40)
            .map(|n| effects::enqueue(&setup, &new_effect(&format!("k{n}"), false, None), 100).unwrap().id)
            .collect();
        let ids = Arc::new(ids);
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|owner| {
                let (path, ids, barrier) = (path.clone(), ids.clone(), barrier.clone());
                std::thread::spawn(move || {
                    let conn = open(&path);
                    barrier.wait();
                    let mut won = Vec::new();
                    for id in ids.iter() {
                        if let Claim::Claimed(effect) = effects::claim(&conn, *id, owner, 1_000, 60_000).unwrap() {
                            won.push(effect.id);
                        }
                    }
                    won
                })
            })
            .collect();
        let mut all: Vec<i64> = workers.into_iter().flat_map(|w| w.join().unwrap()).collect();
        all.sort_unstable();
        let mut expected = (*ids).clone();
        expected.sort_unstable();
        assert_eq!(all, expected, "cada efeito tem exatamente um dono");
        for id in ids.iter() {
            let effect = effects::get(&setup, *id).unwrap().unwrap();
            assert_eq!((effect.state, effect.attempts), (EffectState::Running, 1));
        }
        drop(setup);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn claim_next_de_dois_workers_reparte_sem_repetir() {
        let path = temp_db("next");
        let setup = open(&path);
        for n in 0..30 {
            effects::enqueue(&setup, &new_effect(&format!("k{n}"), false, None), 100).unwrap();
        }
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|owner| {
                let (path, barrier) = (path.clone(), barrier.clone());
                std::thread::spawn(move || {
                    let conn = open(&path);
                    barrier.wait();
                    let mut won = Vec::new();
                    while let Some(effect) = effects::claim_next(&conn, None, owner, 1_000, 60_000).unwrap() {
                        won.push(effect.id);
                    }
                    won
                })
            })
            .collect();
        let mut all: Vec<i64> = workers.into_iter().flat_map(|w| w.join().unwrap()).collect();
        all.sort_unstable();
        let before = all.len();
        all.dedup();
        assert_eq!((before, all.len()), (30, 30), "30 efeitos, 30 donos distintos");
        drop(setup);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
