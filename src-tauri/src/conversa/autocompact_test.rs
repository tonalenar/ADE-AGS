//! Testes do autocompact: configuração, cálculo de uso, decisão (puros), o mapeamento do comando por provedor e o
//! reducer de eventos da compactação. Sem relógio nem processo: tudo recebe o "agora" e o estado.

use super::autocompact::*;
use crate::canal::timeline::{Item, ItemKind, ToolStatus};

fn usage(used: u64, window: u64, at: i64) -> Usage {
    Usage { used, window, at: Some(at), id: "usage:a".into() }
}

fn gate() -> Gate {
    Gate {
        enabled: true,
        mechanism: Mechanism::AdeCommand,
        native_on: false,
        threshold_pct: 83,
        usage: Some(usage(170_000, 200_000, 10)),
        last_compaction_at: None,
        working: false,
        compacting: false,
        pending_request: false,
        last_attempt: None,
    }
}

// ── configuração ─────────────────────────────────────────────────────────

#[test]
fn sem_configuracao_o_autocompact_nasce_ligado_com_o_limiar_do_claude_code() {
    let cfg = parse_config(None);
    assert!(cfg.enabled);
    assert!(cfg.enabled_for("codex"));
    assert_eq!(cfg.effective_pct("codex"), DEFAULT_PCT);
    assert_eq!(cfg.explicit_pct("claude-code"), None);
}

#[test]
fn a_configuracao_por_agente_vence_a_global_e_o_limiar_e_limitado() {
    let cfg = parse_config(Some(r#"{"enabled":true,"agents":{"codex":{"enabled":false},"claude-code":{"thresholdPct":99},"gemini-cli":{"thresholdPct":10}}}"#));
    assert!(!cfg.enabled_for("codex"));
    assert!(cfg.enabled_for("claude-code"));
    assert_eq!(cfg.explicit_pct("claude-code"), Some(MAX_PCT));
    assert_eq!(cfg.explicit_pct("gemini-cli"), Some(MIN_PCT));
}

#[test]
fn o_interruptor_global_desliga_todos_os_agentes() {
    let cfg = parse_config(Some(r#"{"enabled":false,"agents":{"codex":{"enabled":true}}}"#));
    assert!(!cfg.enabled_for("codex"));
}

#[test]
fn lixo_na_configuracao_volta_ao_padrao_ligado() {
    for raw in ["", "não é json", "[]", "null", r#"{"enabled":"sim"}"#] {
        let cfg = parse_config(Some(raw));
        assert!(cfg.enabled, "{raw:?}");
    }
}

// ── cálculo de uso ───────────────────────────────────────────────────────

#[test]
fn o_percentual_e_usado_sobre_a_janela_e_sem_janela_nao_ha_medida() {
    assert_eq!(percent(100_000, 200_000), Some(50.0));
    assert_eq!(percent(250_000, 200_000), Some(100.0));
    assert_eq!(percent(10, 0), None);
}

#[test]
fn o_uso_do_claude_vem_da_entrada_e_a_janela_do_result_ou_do_modelo() {
    let mut item = Item::usage("usage:m1".into(), Some(5), 9_000);
    item.context_tokens = Some(150_000);
    item.context_window = Some(1_000_000);
    let u = usage_of(&item, "claude-code", Some("opus")).unwrap();
    assert_eq!((u.used, u.window), (150_000, 1_000_000));

    item.context_window = None;
    let u = usage_of(&item, "claude-code", Some("opus")).unwrap();
    assert_eq!(u.window, 200_000, "sem janela informada, o Claude padrão tem 200k");
    let u = usage_of(&item, "claude-code", Some("opus[1m]")).unwrap();
    assert_eq!(u.window, 1_000_000);
}

#[test]
fn o_uso_do_codex_precisa_da_janela_informada_pelo_app_server() {
    let mut item = Item::usage("usage:t1".into(), Some(5), 9_000);
    item.context_tokens = Some(120_000);
    assert!(usage_of(&item, "codex", None).is_none(), "sem modelContextWindow não se inventa a janela");
    item.context_window = Some(258_000);
    assert_eq!(usage_of(&item, "codex", None).unwrap().window, 258_000);
}

#[test]
fn agente_sem_medida_de_contexto_nao_tem_uso() {
    let mut item = Item::usage("usage:x".into(), Some(5), 9_000);
    item.context_tokens = Some(150_000);
    item.context_window = Some(200_000);
    assert!(usage_of(&item, "opencode", None).is_none());
    assert!(usage_of(&item, "cursor", None).is_none());
}

#[test]
fn a_janela_do_claude_code_para_um_limiar_em_porcentagem() {
    // limiar p da janela W = p·W + reserva de 33k do Claude Code
    assert_eq!(claude_window_setting(83, 200_000), 199_000);
    assert_eq!(claude_window_setting(50, 200_000), 133_000);
    assert_eq!(claude_window_setting(95, 1_000_000), 983_000);
    assert_eq!(claude_window_setting(95, 1_100_000), 1_000_000, "limitado ao máximo aceito pelo Claude Code");
    assert_eq!(claude_window_setting(50, 100_000), 100_000, "limitado ao mínimo aceito");
}

#[test]
fn o_claude_compacta_sozinho_a_menos_que_a_flag_ou_o_ambiente_digam_o_contrario() {
    assert!(claude_native_auto_on(None, false));
    assert!(claude_native_auto_on(Some(r#"{"autoCompactEnabled":true}"#), false));
    assert!(!claude_native_auto_on(Some(r#"{"autoCompactEnabled":false}"#), false));
    assert!(!claude_native_auto_on(None, true));
    assert!(claude_native_auto_on(Some("lixo"), false));
}

// ── decisão ──────────────────────────────────────────────────────────────

#[test]
fn acima_do_limiar_e_com_a_conversa_livre_compacta() {
    assert_eq!(decide(&gate()), Ok(()));
}

#[test]
fn abaixo_do_limiar_nao_compacta() {
    let mut g = gate();
    g.usage = Some(usage(100_000, 200_000, 10));
    assert_eq!(decide(&g), Err(Skip::BelowThreshold));
    g.usage = Some(usage(165_999, 200_000, 10));
    assert_eq!(decide(&g), Err(Skip::BelowThreshold), "83% de 200k são 166.000");
    g.usage = Some(usage(166_000, 200_000, 10));
    assert_eq!(decide(&g), Ok(()));
}

#[test]
fn nunca_compacta_no_meio_de_um_turno() {
    let mut g = gate();
    g.working = true;
    assert_eq!(decide(&g), Err(Skip::Working));
}

#[test]
fn nao_compacta_com_pedido_pendente_nem_com_compactacao_em_curso() {
    let mut g = gate();
    g.pending_request = true;
    assert_eq!(decide(&g), Err(Skip::PendingRequest));
    g.pending_request = false;
    g.compacting = true;
    assert_eq!(decide(&g), Err(Skip::Compacting));
}

#[test]
fn desligado_ou_sem_mecanismo_nao_compacta() {
    let mut g = gate();
    g.enabled = false;
    assert_eq!(decide(&g), Err(Skip::Disabled));
    g.enabled = true;
    g.mechanism = Mechanism::Unsupported;
    assert_eq!(decide(&g), Err(Skip::Unsupported));
}

#[test]
fn nao_duplica_quando_o_agente_compacta_sozinho() {
    let mut g = gate();
    g.mechanism = Mechanism::NativeAuto;
    g.native_on = true;
    assert_eq!(decide(&g), Err(Skip::NativeHandles));
    // flag desligada: o agente não compacta sozinho, então a ADE assume
    g.native_on = false;
    assert_eq!(decide(&g), Ok(()));
}

#[test]
fn sem_medida_de_contexto_nao_inventa() {
    let mut g = gate();
    g.usage = None;
    assert_eq!(decide(&g), Err(Skip::NoMeasure));
}

#[test]
fn uso_anterior_a_ultima_compactacao_nao_dispara_de_novo() {
    let mut g = gate();
    g.last_compaction_at = Some(10);
    assert_eq!(decide(&g), Err(Skip::StaleUsage), "o uso medido é o de antes da compactação");
    g.last_compaction_at = Some(9);
    assert_eq!(decide(&g), Ok(()));
}

#[test]
fn a_mesma_ponta_de_contexto_so_e_tentada_uma_vez() {
    let mut g = gate();
    g.last_attempt = Some(("usage:a".into(), 170_000));
    assert_eq!(decide(&g), Err(Skip::AlreadyAttempted));
    g.last_attempt = Some(("usage:a".into(), 100_000));
    assert_eq!(decide(&g), Ok(()), "outro tamanho de contexto é outra ponta");
}

// ── mapeamento por provedor ──────────────────────────────────────────────

#[test]
fn o_comando_de_compactacao_de_cada_provedor() {
    assert_eq!(command_for("claude-code"), Some(Command::Slash("/compact")));
    assert_eq!(command_for("codex"), Some(Command::ThreadCompactStart));
    for agent in ["opencode", "antigravity", "cursor", "gemini-cli", "kimi-code", "hermes", "local-acp:x"] {
        assert_eq!(command_for(agent), None, "{agent}");
    }
}

#[test]
fn o_mecanismo_do_chat_por_agente() {
    assert_eq!(chat_mechanism("claude-code"), Mechanism::NativeAuto);
    assert_eq!(chat_mechanism("codex"), Mechanism::AdeCommand);
    for agent in ["opencode", "antigravity", "cursor", "local-acp:meu"] {
        assert_eq!(chat_mechanism(agent), Mechanism::Unsupported, "{agent}");
    }
}

#[test]
fn a_tabela_de_agentes_diz_o_que_e_suportado_e_porque() {
    let rows = plan_table();
    let get = |surface: &str, agent: &str| rows.iter().find(|r| r.surface == surface && r.agent_id == agent).unwrap_or_else(|| panic!("{surface}/{agent}"));
    assert!(get("chat", "claude-code").supported);
    assert!(get("chat", "codex").supported);
    assert!(!get("chat", "opencode").supported);
    assert!(!get("chat", "cursor").supported);
    assert!(get("tui", "claude-code").supported, "TUI do Claude: compacta sozinha, a ADE só garante o limite");
    assert!(!get("tui", "claude-code").ade_types, "a ADE nunca digita num terminal");
    for row in rows.iter().filter(|r| !r.supported) {
        assert!(!row.reason.is_empty(), "{}/{} precisa explicar por que está desligado", row.surface, row.agent_id);
    }
    assert!(rows.iter().all(|r| !(r.surface == "tui" && r.ade_types)));
}

// ── eventos da compactação ───────────────────────────────────────────────

fn ids() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("compaction:{n}")
    }
}

#[test]
fn compactando_vira_um_aviso_em_andamento_e_o_fim_o_fecha_com_antes_e_depois() {
    let mut state = State::default();
    let mut id = ids();
    let started = reduce(&mut state, Event::Started { trigger: Some(Trigger::Auto), before: None }, 100, &mut id).unwrap();
    assert_eq!(started.kind, ItemKind::Notice);
    assert_eq!(started.label.as_deref(), Some("compaction"));
    assert_eq!(started.status, Some(ToolStatus::Running));
    assert!(state.is_active(100));

    let done = reduce(&mut state, Event::Finished { trigger: Some(Trigger::Auto), before: Some(180_000), after: Some(42_000), ok: true }, 200, &mut id).unwrap();
    assert_eq!(done.id, started.id, "o mesmo item passa de «Compactando…» para «Contexto compactado»");
    assert_eq!(done.status, Some(ToolStatus::Done));
    assert_eq!((done.context_tokens, done.tokens), (Some(180_000), Some(42_000)));
    assert!(!state.is_active(200));
}

#[test]
fn comecar_de_novo_com_uma_compactacao_em_curso_nao_duplica_o_aviso() {
    let mut state = State::default();
    let mut id = ids();
    assert!(reduce(&mut state, Event::Started { trigger: None, before: None }, 1, &mut id).is_some());
    assert!(reduce(&mut state, Event::Started { trigger: None, before: None }, 2, &mut id).is_none());
}

#[test]
fn a_compactacao_pedida_pela_ade_ja_abre_o_aviso_e_o_evento_do_agente_o_fecha_sem_duplicar() {
    let mut state = State::default();
    let mut id = ids();
    let started = reduce(&mut state, Event::Started { trigger: Some(Trigger::Ade), before: Some(170_000) }, 1, &mut id).unwrap();
    assert_eq!(started.text.as_deref(), Some("ade"));
    assert_eq!(started.context_tokens, Some(170_000));
    // o agente anuncia o começo depois: já está registrado
    assert!(reduce(&mut state, Event::Started { trigger: Some(Trigger::Auto), before: None }, 2, &mut id).is_none());
    let done = reduce(&mut state, Event::Finished { trigger: Some(Trigger::Auto), before: Some(171_000), after: Some(40_000), ok: true }, 3, &mut id).unwrap();
    assert_eq!(done.id, started.id);
    assert_eq!(done.text.as_deref(), Some("ade"), "o gatilho é o de quem pediu");
    assert_eq!((done.context_tokens, done.tokens), (Some(170_000), Some(40_000)), "o «antes» é o medido pela ADE");
}

#[test]
fn o_pedido_que_falha_fecha_o_aviso_com_o_motivo_e_libera_a_conversa() {
    let mut state = State::default();
    let mut id = ids();
    let started = reduce(&mut state, Event::Started { trigger: Some(Trigger::Ade), before: Some(1) }, 1, &mut id).unwrap();
    let failed = reduce(&mut state, Event::Failed { message: "sessão fechou".into() }, 2, &mut id).unwrap();
    assert_eq!(failed.id, started.id);
    assert_eq!(failed.status, Some(ToolStatus::Error));
    assert_eq!(failed.output.as_deref(), Some("sessão fechou"));
    assert!(!state.is_active(3));
}

#[test]
fn fim_sem_inicio_ainda_gera_o_aviso_de_contexto_compactado() {
    let mut state = State::default();
    let mut id = ids();
    let done = reduce(&mut state, Event::Finished { trigger: Some(Trigger::Manual), before: Some(90_000), after: None, ok: true }, 5, &mut id).unwrap();
    assert_eq!(done.status, Some(ToolStatus::Done));
    assert_eq!(done.text.as_deref(), Some("manual"));
}

#[test]
fn o_fim_do_turno_fecha_a_compactacao_que_ficou_aberta_e_marca_erro_se_o_turno_falhou() {
    let mut state = State::default();
    let mut id = ids();
    reduce(&mut state, Event::Started { trigger: None, before: None }, 1, &mut id);
    let item = reduce(&mut state, Event::TurnEnded { ok: false }, 2, &mut id).unwrap();
    assert_eq!(item.status, Some(ToolStatus::Error));
    assert!(reduce(&mut state, Event::TurnEnded { ok: true }, 3, &mut id).is_none(), "sem compactação aberta não há o que fechar");
}

#[test]
fn compactacao_esquecida_expira_e_nao_segura_a_conversa_para_sempre() {
    let mut state = State::default();
    let mut id = ids();
    reduce(&mut state, Event::Started { trigger: None, before: None }, 0, &mut id);
    assert!(state.is_active(ACTIVE_TTL_MS - 1));
    assert!(!state.is_active(ACTIVE_TTL_MS + 1));
    // uma nova compactação depois da expirada volta a abrir o aviso
    assert!(reduce(&mut state, Event::Started { trigger: None, before: None }, ACTIVE_TTL_MS + 5, &mut id).is_some());
}

#[test]
fn mensagens_durante_a_compactacao_esperam_na_fila_e_saem_ao_fim() {
    // A fila do composer segura a mensagem enquanto há um aviso «Compactando…» e solta quando ele fecha: aqui a
    // regra pura do lado do backend, que também recusa o envio direto enquanto a compactação roda.
    let mut state = State::default();
    let mut id = ids();
    assert!(!state.is_active(1));
    reduce(&mut state, Event::Started { trigger: Some(Trigger::Ade), before: Some(1) }, 1, &mut id);
    assert!(state.is_active(2), "o envio direto é recusado (Busy) e a fila do composer segura a mensagem");
    reduce(&mut state, Event::Finished { trigger: None, before: None, after: None, ok: true }, 3, &mut id);
    assert!(!state.is_active(4), "depois do fim a conversa volta a aceitar mensagens");
}

// ── leitura dos eventos dos motores ──────────────────────────────────────

#[test]
fn o_claude_anuncia_o_comeco_e_o_fim_da_compactacao() {
    use super::claude_map::compaction_event;
    use serde_json::json;
    let started = json!({ "type": "system", "subtype": "status", "status": "compacting" });
    assert_eq!(compaction_event(&started), Some(Event::Started { trigger: None, before: None }));
    let boundary = json!({ "type": "system", "subtype": "compact_boundary", "compact_metadata": { "trigger": "auto", "pre_tokens": 180000, "post_tokens": 42000 } });
    assert_eq!(compaction_event(&boundary), Some(Event::Finished { trigger: Some(Trigger::Auto), before: Some(180_000), after: Some(42_000), ok: true }));
    let manual = json!({ "type": "system", "subtype": "compact_boundary", "compact_metadata": { "trigger": "manual", "pre_tokens": 9 } });
    assert_eq!(compaction_event(&manual), Some(Event::Finished { trigger: Some(Trigger::Manual), before: Some(9), after: None, ok: true }));
    // outros `system` e o status sem compactar não são compactação
    assert_eq!(compaction_event(&json!({ "type": "system", "subtype": "init" })), None);
    assert_eq!(compaction_event(&json!({ "type": "system", "subtype": "status", "status": null })), None);
}

#[test]
fn a_janela_de_contexto_vem_do_result_do_claude_e_a_maior_vence() {
    use super::claude_map::context_window_of;
    use serde_json::json;
    let result = json!({ "type": "result", "modelUsage": { "claude-opus": { "contextWindow": 1_000_000 }, "claude-haiku": { "contextWindow": 200_000 } } });
    assert_eq!(context_window_of(&result), Some(1_000_000));
    assert_eq!(context_window_of(&json!({ "type": "result" })), None);
}

#[test]
fn o_codex_informa_o_contexto_da_ultima_chamada_e_a_janela_do_modelo() {
    use super::codex_map::{usage_item, TurnTokens};
    use serde_json::json;
    let mut tokens = TurnTokens::default();
    let params = json!({ "turnId": "t1", "tokenUsage": { "total": { "totalTokens": 300000 }, "last": { "totalTokens": 120000 }, "modelContextWindow": 258000 } });
    let item = usage_item(&mut tokens, &params, Some(7)).unwrap();
    assert_eq!((item.context_tokens, item.context_window), (Some(120_000), Some(258_000)));
    let u = usage_of(&item, "codex", None).unwrap();
    assert_eq!(percent(u.used, u.window).map(|p| p.round() as u64), Some(47));
}
