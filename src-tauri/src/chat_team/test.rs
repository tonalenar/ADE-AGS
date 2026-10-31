use crate::peer_queue::store::{admit, Admission, NewMessage, State};

use super::api::{self, NewTeam};
use super::model::{self, decide, Ask, Policy, Verdict};
use super::store::{self, MemberPatch, NewMember, TeamRow};

fn db() -> rusqlite::Connection {
    crate::database::test_db()
}

fn team(conn: &rusqlite::Connection, orchestrator: &str) -> String {
    let input = NewTeam { orchestrator: orchestrator.into(), agent_id: "claude-code".into(), label: "Claude Code".into(), cwd: "/r".into(), title: "Modo chat".into() };
    api::create(conn, input, 1).unwrap().0.team.id
}

fn member(id: &str, role: &str) -> NewMember {
    NewMember { member: id.into(), agent_id: "codex".into(), label: format!("Agente {id}"), role: role.into(), ..Default::default() }
}

#[test]
fn a_migracao_e_aditiva_e_roda_duas_vezes() {
    let conn = db();
    store::migrate(&conn).unwrap();
    store::migrate(&conn).unwrap();
    team(&conn, "tab-1");
    store::migrate(&conn).unwrap();
    assert_eq!(store::teams(&conn).unwrap().len(), 1, "migrar de novo não apaga nada");
}

#[test]
fn criar_e_idempotente_e_conta_o_orquestrador() {
    let conn = db();
    let id = team(&conn, "tab-1");
    let (again, created) = api::create(&conn, NewTeam { orchestrator: "tab-1".into(), ..Default::default() }, 2).unwrap();
    assert!(!created);
    assert_eq!(again.team.id, id);
    assert_eq!(again.headcount, 1);
    api::link(&conn, &id, member("thread:a", "frontend"), false, 3).unwrap();
    api::link(&conn, &id, member("tab-2", "backend"), false, 4).unwrap();
    let view = api::team_of(&conn, "thread:a").unwrap().unwrap();
    assert_eq!(view.headcount, 3, "2 integrantes + o orquestrador");
    assert_eq!(view.members.iter().map(|m| m.member.as_str()).collect::<Vec<_>>(), ["thread:a", "tab-2"], "na ordem em que entraram");
}

#[test]
fn um_agente_esta_em_um_time_so() {
    let conn = db();
    let a = team(&conn, "tab-1");
    let b = team(&conn, "tab-9");
    api::link(&conn, &a, member("tab-2", "qa"), false, 2).unwrap();
    assert!(api::link(&conn, &b, member("tab-2", "qa"), false, 3).unwrap_err().contains("outro time"));
    assert!(api::link(&conn, &a, member("tab-1", "qa"), false, 3).unwrap_err().contains("próprio time"));
    assert!(api::link(&conn, &a, member("tab-9", "qa"), false, 3).unwrap_err().contains("orquestrador de outro"));
    assert!(api::create(&conn, NewTeam { orchestrator: "tab-2".into(), ..Default::default() }, 4).unwrap_err().contains("integrante"));
}

#[test]
fn ligar_de_novo_atualiza_o_papel_sem_duplicar() {
    let conn = db();
    let id = team(&conn, "tab-1");
    api::link(&conn, &id, member("tab-2", "qa"), false, 2).unwrap();
    let again = api::link(&conn, &id, NewMember { policy: Some(Policy::Edits), ..member("tab-2", "backend") }, false, 3).unwrap();
    assert_eq!(again.role, "backend");
    assert_eq!(again.policy, Policy::Edits);
    assert_eq!(store::members(&conn, &id).unwrap().len(), 1);
}

#[test]
fn o_revisor_nasce_so_leitura_e_os_outros_supervisionados() {
    let conn = db();
    let id = team(&conn, "tab-1");
    assert_eq!(api::link(&conn, &id, member("tab-2", "reviewer"), false, 2).unwrap().policy, Policy::Read);
    assert_eq!(api::link(&conn, &id, member("tab-3", "frontend"), false, 2).unwrap().policy, Policy::Ask);
    assert_eq!(api::link(&conn, &id, member("tab-4", ""), false, 2).unwrap().role, "generalist", "sem papel = generalista");
}

#[test]
fn o_agente_nao_aumenta_a_permissao_de_ninguem() {
    let conn = db();
    let id = team(&conn, "tab-1");
    let full = NewMember { policy: Some(Policy::Full), ..member("tab-2", "backend") };
    assert!(api::link(&conn, &id, full.clone(), true, 2).unwrap_err().contains("Só a pessoa"));
    // A pessoa pode; depois o agente só restringe.
    api::link(&conn, &id, full, false, 2).unwrap();
    let lower = MemberPatch { policy: Some(Policy::Ask), ..Default::default() };
    assert_eq!(api::update(&conn, &id, "tab-2", lower, true, 3).unwrap().policy, Policy::Ask);
    let raise = MemberPatch { policy: Some(Policy::Edits), ..Default::default() };
    assert!(api::update(&conn, &id, "tab-2", raise, true, 4).is_err());
}

#[test]
fn desligar_e_desfazer_so_tiram_as_ligacoes() {
    let conn = db();
    let id = team(&conn, "tab-1");
    api::link(&conn, &id, member("tab-2", "qa"), false, 2).unwrap();
    assert!(!api::unlink(&conn, "outro", "tab-2", 3).unwrap(), "de outro time não sai");
    assert!(api::unlink(&conn, &id, "tab-2", 3).unwrap());
    assert!(api::team_of(&conn, "tab-2").unwrap().is_none());
    api::link(&conn, &id, member("tab-3", "qa"), false, 4).unwrap();
    assert!(store::delete_team(&conn, &id).unwrap());
    assert!(store::member(&conn, "tab-3").unwrap().is_none());
    assert!(api::team_of(&conn, "tab-1").unwrap().is_none());
}

#[test]
fn o_escopo_do_chat_da_equipe_e_o_do_time() {
    let conn = db();
    let id = team(&conn, "tab-1");
    api::link(&conn, &id, member("thread:x", "qa"), false, 2).unwrap();
    assert_eq!(api::scope_of(&conn, "tab-1"), Some(format!("t:{id}")));
    assert_eq!(api::scope_of(&conn, "thread:x"), Some(format!("t:{id}")));
    assert_eq!(api::scope_of(&conn, "tab-9"), None);
    assert_eq!(store::thread_refs(&conn).unwrap(), ["thread:x"]);
}

#[test]
fn o_teto_de_integrantes_vale() {
    let conn = db();
    let id = team(&conn, "tab-1");
    for i in 0..model::MAX_MEMBERS {
        api::link(&conn, &id, member(&format!("tab-m{i}"), "qa"), false, 2).unwrap();
    }
    assert!(api::link(&conn, &id, member("tab-extra", "qa"), false, 3).unwrap_err().contains("integrantes"));
}

fn tell<'a>(from: &'a str, to: &'a str, kind: &'a str, text: &'a str) -> NewMessage<'a> {
    NewMessage { kind, from_tab_id: from, from_name: "Lead", to_tab_id: to, to_name: "Codex", text, ..Default::default() }
}

#[test]
fn o_fio_tem_as_delegacoes_e_as_entregas_do_time() {
    let conn = db();
    let id = team(&conn, "tab-1");
    api::link(&conn, &id, member("tab-2", "frontend"), false, 2).unwrap();
    let task = "Lead pediu sua ajuda nisto.\nTarefa: ChatView + Composer\nRestrições: nenhuma";
    assert!(matches!(admit(&conn, &tell("tab-1", "tab-2", "tell", task), State::Queued, 10).unwrap(), Admission::New(_)));
    // De fora do time não entra.
    admit(&conn, &tell("tab-1", "tab-7", "tell", "outra coisa"), State::Queued, 11).unwrap();
    admit(&conn, &tell("tab-2", "tab-1", "handoff", "ENTREGA #42: pronto · 3 arquivo(s)"), State::Queued, 12).unwrap();
    let view = api::team_of(&conn, "tab-1").unwrap().unwrap();
    let feed = api::feed(&conn, &view, 50).unwrap();
    assert_eq!(feed.len(), 2);
    assert_eq!((feed[0].kind, feed[0].member.as_str(), feed[0].task.as_str()), ("delegation", "tab-2", "ChatView + Composer"));
    assert_eq!((feed[1].kind, feed[1].handoff), ("delivery", Some(42)));
}

#[test]
fn o_numero_da_entrega_sai_da_linha() {
    assert_eq!(api::handoff_number("ENTREGA #12: x"), Some(12));
    assert_eq!(api::handoff_number("oi"), None);
}

#[test]
fn a_politica_decide_sozinha_so_o_que_pode() {
    assert_eq!(decide(Policy::Read, Ask::Read, false), Verdict::Allow);
    assert_eq!(decide(Policy::Read, Ask::Edit, false), Verdict::Deny);
    assert_eq!(decide(Policy::Ask, Ask::Edit, false), Verdict::Ask);
    assert_eq!(decide(Policy::Edits, Ask::Edit, false), Verdict::Allow);
    assert_eq!(decide(Policy::Edits, Ask::Command, false), Verdict::Ask);
    assert_eq!(decide(Policy::Full, Ask::Network, false), Verdict::Allow);
    assert_eq!(decide(Policy::Full, Ask::Command, true), Verdict::Ask, "risco alto nunca é automático");
}

#[test]
fn a_politica_aceita_os_nomes_da_tela() {
    assert_eq!(Policy::parse("Só leitura").unwrap(), Policy::Read);
    assert_eq!(Policy::parse("Pede tudo").unwrap(), Policy::Ask);
    assert_eq!(Policy::parse("aceita edições").unwrap(), Policy::Edits);
    assert_eq!(Policy::parse("acesso total").unwrap(), Policy::Full);
    assert!(Policy::parse("tudo liberado").is_err());
}

#[test]
fn os_papeis_do_time_aceitam_os_apelidos_da_prancheta() {
    // Só o catálogo: o teste não lê os papéis da pessoa em `~/.ags`.
    let roles: Vec<crate::canvas::roles::Role> = crate::roles::BUILTIN_ROLES
        .iter()
        .map(|r| crate::canvas::roles::Role { id: r.id.into(), label: r.label.into(), instructions: r.instructions.into(), builtin: true })
        .collect();
    assert_eq!(model::role_id(&roles, "UI").as_deref(), Some("frontend"));
    assert_eq!(model::role_id(&roles, "Testes").as_deref(), Some("qa"));
    assert_eq!(model::role_id(&roles, "Revisor").as_deref(), Some("reviewer"));
    assert_eq!(model::role_id(&roles, "backend").as_deref(), Some("backend"));
    assert_eq!(model::role_id(&roles, "astronauta"), None);
    assert_eq!(model::branch_for("frontend"), "team/ui");
    assert_eq!(model::branch_for("qa"), "team/tests");
    assert_eq!(model::branch_for("backend"), "team/backend");
}

#[test]
fn o_briefing_diz_o_papel_a_branch_e_como_responder() {
    let me = model::Named { name: "Codex", agent: "codex", role: "Frontend", policy: Policy::Edits, branch: Some("team/ui"), subagent: false };
    let text = model::member_briefing("Claude Code", &me, "Faça a UI.");
    assert!(text.contains("time de Claude Code como Frontend"));
    assert!(text.contains("aceita edições"));
    assert!(text.contains("team/ui"));
    assert!(text.contains("ags peer tell \"Claude Code\""));
    assert!(text.contains("ags peer deliver"));
    let roster = model::roster_notice(&[me]);
    assert!(roster.contains("Codex (codex; Frontend; aceita edições, team/ui)"));
    assert!(roster.contains("ags peer tell"));
    assert!(model::roster_notice(&[]).contains("ainda não há ninguém"));
}

#[test]
fn a_entrega_entre_integrantes_do_time_vale_fora_do_canvas_de_missao() {
    let conn = db();
    let id = team(&conn, "tab-1");
    api::link(&conn, &id, member("thread:x", "qa"), false, 2).unwrap();
    let boards = crate::canvas::Boards::new();
    let recorded = crate::missions::messages::record_handoff(&conn, &boards, ("thread:x", "Kimi"), ("tab-1", "Lead"), "Entrega: ok", "{}", 5).unwrap();
    let handoff = recorded.expect("o time é o escopo da entrega");
    let (scope, from, _) = crate::missions::messages::handoff(&conn, handoff).unwrap().unwrap();
    assert_eq!((scope.as_str(), from.as_str()), (format!("t:{id}").as_str(), "Kimi"));
    // Fora de time e de canvas, continua sem escopo.
    assert!(crate::missions::messages::record_handoff(&conn, &boards, ("tab-8", "A"), ("tab-9", "B"), "x", "{}", 6).unwrap().is_none());
}

// ── O nome do orquestrador no `ags peer` ─────────────────────────────

#[test]
fn o_nome_do_orquestrador_e_o_da_aba_e_nao_o_rotulo_do_time() {
    // O integrante recebia `ags peer tell "Claude Code"`, mas a aba se chama "Claude Code — pasta": unknown_target.
    assert_eq!(api::peer_name("Claude Code", "Claude Code — autovale-expo", "Claude Code", false), "Claude Code — autovale-expo");
    assert_eq!(api::peer_name("Claude Code", "", "Claude Code CLI", false), "Claude Code CLI", "sem título, o agente");
    assert_eq!(api::peer_name("", "", "", false), "o orquestrador");
}

#[test]
fn conversa_por_protocolo_usa_o_rotulo_do_time_como_o_peer_a_chama() {
    // `team_threads` nomeia a conversa pelo rótulo gravado, depois pelo título.
    assert_eq!(api::peer_name("Orq", "Título", "Claude Code", true), "Orq");
    assert_eq!(api::peer_name("", "Título", "Claude Code", true), "Título");
}

#[test]
fn o_nome_vem_do_titulo_da_aba_gravada() {
    let conn = db();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)", []).unwrap();
    conn.execute("INSERT INTO windows (id, label, workspace_id, is_open, last_active) VALUES ('win', 'main', 'w1', 1, 0)", []).unwrap();
    conn.execute(
        "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, created_at, last_active, opened_at) VALUES ('tab-1', 'win', 'Claude Code — autovale-expo', 'claude-code', 'Claude Code', 'claude', '/r', 0, 0, 0)",
        [],
    )
    .unwrap();
    let id = team(&conn, "tab-1");
    let row = store::team(&conn, &id).unwrap().unwrap();
    assert_eq!(row.label, "Claude Code");
    assert_eq!(api::orchestrator_peer_name(&conn, &row), "Claude Code — autovale-expo");
    let gone = TeamRow { orchestrator: "tab-sumiu".into(), ..row };
    assert_eq!(api::orchestrator_peer_name(&conn, &gone), "Claude Code", "aba que sumiu: o rótulo");
}

#[test]
fn subagente_nasce_marcado_e_persiste() {
    let conn = db();
    let id = team(&conn, "tab-1");
    let mut sub = member("tab-2", "qa");
    sub.subagent = Some(true);
    let row = api::link(&conn, &id, sub, false, 2).unwrap();
    assert!(row.subagent, "ligado como subagente");
    assert!(!api::link(&conn, &id, member("tab-3", "qa"), false, 3).unwrap().subagent, "sem dizer nada, não é subagente");
    assert!(store::member(&conn, "tab-2").unwrap().unwrap().subagent, "lido de volta do banco");
}

#[test]
fn ligar_de_novo_sem_dizer_mantem_a_marca_e_dizendo_troca() {
    let conn = db();
    let id = team(&conn, "tab-1");
    let mut sub = member("tab-2", "qa");
    sub.subagent = Some(true);
    api::link(&conn, &id, sub, false, 2).unwrap();
    let kept = api::link(&conn, &id, member("tab-2", "backend"), false, 3).unwrap();
    assert!(kept.subagent, "relink sem --subagent não desmarca");
    let mut off = member("tab-2", "backend");
    off.subagent = Some(false);
    assert!(!api::link(&conn, &id, off, false, 4).unwrap().subagent);
}

#[test]
fn update_liga_e_desliga_a_marca_sem_mexer_no_resto() {
    let conn = db();
    let id = team(&conn, "tab-1");
    api::link(&conn, &id, member("tab-2", "frontend"), false, 2).unwrap();
    let patch = MemberPatch { subagent: Some(true), ..Default::default() };
    let row = api::update(&conn, &id, "tab-2", patch, false, 3).unwrap();
    assert!(row.subagent);
    assert_eq!(row.role, "frontend", "o papel não muda");
    let row = api::update(&conn, &id, "tab-2", MemberPatch { role: Some("qa".into()), ..Default::default() }, false, 4).unwrap();
    assert!(row.subagent, "mudar o papel não desmarca");
    let row = api::update(&conn, &id, "tab-2", MemberPatch { subagent: Some(false), ..Default::default() }, false, 5).unwrap();
    assert!(!row.subagent);
}

#[test]
fn a_migracao_acrescenta_a_coluna_a_uma_tabela_antiga_sem_perder_linhas() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE chat_team (id TEXT PRIMARY KEY, orchestrator TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE chat_team_member (team_id TEXT NOT NULL REFERENCES chat_team(id) ON DELETE CASCADE, member TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', model TEXT, policy TEXT NOT NULL DEFAULT 'ask', branch TEXT, worktree TEXT, origin TEXT NOT NULL DEFAULT 'existing', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         INSERT INTO chat_team VALUES ('t1','tab-1','claude-code','Claude','/r','',1,1);
         INSERT INTO chat_team_member VALUES ('t1','tab-2','codex','Codex','qa',NULL,'ask',NULL,NULL,'existing',0,1,1);",
    )
    .unwrap();
    store::migrate(&conn).unwrap();
    store::migrate(&conn).unwrap();
    let old = store::member(&conn, "tab-2").unwrap().expect("a linha antiga continua");
    assert!(!old.subagent, "linha antiga entra como não subagente");
    assert_eq!(old.role, "qa");
}

#[test]
fn o_briefing_do_subagente_usa_a_frase_do_canvas_e_o_resumo_o_marca() {
    let me = model::Named { name: "Codex", agent: "codex", role: "QA", policy: Policy::Ask, branch: None, subagent: true };
    let text = model::member_briefing("Claude Code", &me, "");
    assert!(text.contains("Você é um subagente: execute as tarefas que o orquestrador enviar e responda com `ags peer tell`."));
    let plain = model::Named { subagent: false, ..me.clone() };
    assert!(!model::member_briefing("Claude Code", &plain, "").contains("subagente"));
    assert!(model::roster_notice(&[me]).contains("QA; supervisionado; subagente"));
}

fn item(kind: crate::canal::timeline::ItemKind, id: &str) -> crate::canal::timeline::Item {
    crate::canal::timeline::Item::new(kind, id.to_string(), None)
}

fn turn_end(id: &str, interrupted: bool, error: Option<&str>) -> crate::canal::timeline::Item {
    let mut end = item(crate::canal::timeline::ItemKind::TurnEnd, id);
    end.interrupted = Some(interrupted);
    end.text = error.map(str::to_string);
    end
}

#[test]
fn o_ask_a_conversa_que_errou_cai_ou_foi_interrompida_sai_com_o_motivo() {
    use crate::canal::timeline::ItemKind::{Assistant, User};
    let ask = || item(User, "u1");
    // Turno que falhou: o erro do `turnEnd` é o motivo.
    let falhou = vec![ask(), turn_end("end:t1", false, Some("API fora do ar"))];
    let reason = model::stopped_reason(&falhou, true).unwrap();
    assert!(reason.contains("API fora do ar") && reason.contains("erro"), "{reason}");
    // Interrompido: diz que foi interrompido, sem culpar o agente.
    let parado = vec![ask(), turn_end("end:t1", true, None)];
    assert!(model::stopped_reason(&parado, true).unwrap().contains("interrompido"));
    // Turno que fechou sem escrever nenhuma fala.
    let mudo = vec![ask(), turn_end("end:t1", false, None)];
    assert!(model::stopped_reason(&mudo, true).unwrap().contains("sem nenhuma resposta"));
    // Processo morto sem `turnEnd`: a conversa fechou.
    assert!(model::stopped_reason(&[ask()], false).unwrap().contains("fechou"));
    // Ainda vivo e sem `turnEnd` da pergunta: não dá para dizer (o turno pode nem ter começado).
    assert_eq!(model::stopped_reason(&[ask()], true), None);
    // O `turnEnd` de um turno ANTERIOR à pergunta não conta.
    let velho = vec![item(User, "u0"), item(Assistant, "a0"), turn_end("end:t0", false, Some("erro antigo")), ask()];
    assert_eq!(model::stopped_reason(&velho, true), None, "o erro antigo não é desta pergunta");
}

// ── Etapa 2: a janela de resposta de uma mensagem ──────────────────────

#[test]
fn a_janela_de_resposta_junta_todas_as_falas_ate_o_fim_do_turno_da_mensagem() {
    use crate::canal::timeline::ItemKind::{Assistant, TurnEnd, User};
    let say = |kind, id: &str, text: &str| crate::canal::timeline::Item { text: Some(text.into()), ..crate::canal::timeline::Item::new(kind, id.into(), None) };
    let items = vec![
        say(User, "u1", "[Mensagem #5 de Líder via ADE AGS] antes"),
        say(Assistant, "a1", "resposta do #5"),
        say(TurnEnd, "e1", ""),
        say(User, "u2", "[Mensagem #12 de Líder via ADE AGS] agora"),
        say(Assistant, "a2", "passo 1"),
        say(Assistant, "a3", "   "),
        say(Assistant, "a4", "passo 2"),
    ];
    let open = model::reply_window(&items, 12);
    assert_eq!((open.start, open.ended), (Some(3), false));
    assert_eq!(open.replies, ["passo 1", "passo 2"], "todas as falas, sem a vazia");
    let mut done = items.clone();
    done.push(say(TurnEnd, "e2", ""));
    done.push(say(Assistant, "a5", "de outro turno"));
    let closed = model::reply_window(&done, 12);
    assert!(closed.ended);
    assert_eq!(closed.replies.len(), 2, "o que vem depois do fim do turno não é resposta desta mensagem");
    assert_eq!(model::reply_window(&items, 1).start, None, "#1 não é prefixo de #12");
    assert_eq!(model::reply_window(&items, 99), model::ReplyWindow::default());
}

// ── Etapa 3 (B2): regras de permissão e o interruptor do time ───────────

mod regras {
    use super::*;
    use crate::chat_team::permission::Kind;

    fn legacy(conn: &rusqlite::Connection, json: &str) {
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('chat.permissions.rules', ?1)", [json]).unwrap();
    }

    #[test]
    fn as_regras_dos_settings_sao_copiadas_uma_vez_sem_apagar_o_setting() {
        let conn = db();
        legacy(&conn, r#"[
            {"id":"r1","kind":"command","pattern":"bun add *","agentId":"codex","createdAt":5},
            {"id":"r2","kind":"edit","pattern":"src/**","agentId":null,"createdAt":6},
            {"id":"","kind":"command","pattern":"x"},
            {"id":"r3","kind":"outro","pattern":"x"},
            {"id":"r4","kind":"command","pattern":"   "},
            "lixo"
        ]"#);
        let rules = store::rules(&conn).unwrap();
        assert_eq!(rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["r1", "r2"], "o lixo fica de fora");
        assert_eq!((rules[0].kind, rules[0].agent_id.as_deref(), rules[0].created_at), (Kind::Command, Some("codex"), 5));
        assert!(rules.iter().all(|r| r.role.is_none() && r.team_id.is_none()), "o escopo de papel/time nasce desligado");
        let kept: String = conn.query_row("SELECT value FROM settings WHERE key = 'chat.permissions.rules'", [], |r| r.get(0)).unwrap();
        assert!(kept.contains("bun add"), "o setting não é apagado: dá para voltar atrás");

        // Rodar de novo não duplica, e apagar tudo não ressuscita as antigas.
        store::migrate(&conn).unwrap();
        assert_eq!(store::rules(&conn).unwrap().len(), 2);
        assert!(store::remove_rule(&conn, "r1").unwrap() && store::remove_rule(&conn, "r2").unwrap());
        store::migrate(&conn).unwrap();
        assert!(store::rules(&conn).unwrap().is_empty(), "a importação é de uma vez só");
    }

    #[test]
    fn sem_settings_nada_e_importado_e_a_migracao_continua_aditiva() {
        let conn = db();
        assert!(store::rules(&conn).unwrap().is_empty());
        team(&conn, "tab-1");
        store::migrate(&conn).unwrap();
        assert_eq!(store::teams(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_pessoa_cria_muda_e_apaga_regras_sem_repetir_a_mesma() {
        let conn = db();
        let a = store::add_rule(&conn, Kind::Command, "  ls *  ", Some("codex"), 10).unwrap();
        assert_eq!((a.pattern.as_str(), a.agent_id.as_deref(), a.role.as_deref()), ("ls *", Some("codex"), None));
        let again = store::add_rule(&conn, Kind::Command, "ls *", Some("codex"), 20).unwrap();
        assert_eq!(again.id, a.id, "a mesma regra não se repete");
        assert_ne!(store::add_rule(&conn, Kind::Command, "ls *", None, 20).unwrap().id, a.id, "outro agente é outra regra");
        assert!(store::add_rule(&conn, Kind::Command, "   ", None, 1).is_err());
        assert!(store::update_rule(&conn, &a.id, Some("ls -la *"), Some(None)).unwrap());
        let changed = store::rules(&conn).unwrap().into_iter().find(|r| r.id == a.id).unwrap();
        assert_eq!((changed.pattern.as_str(), changed.agent_id), ("ls -la *", None));
        store::count_rule_use(&conn, &a.id, 99).unwrap();
        let uses: (i64, i64) = conn.query_row("SELECT uses, last_used_at FROM chat_permission_rule WHERE id = ?1", [&a.id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(uses, (1, 99));
        assert!(store::remove_rule(&conn, &a.id).unwrap() && !store::remove_rule(&conn, &a.id).unwrap());
    }

    #[test]
    fn so_a_pessoa_e_a_origem_possivel_de_uma_regra() {
        let conn = db();
        store::migrate(&conn).unwrap();
        let rejected = conn.execute("INSERT INTO chat_permission_rule (id, kind, pattern, origin, created_at) VALUES ('x', 'command', '*', 'agent', 1)", []);
        assert!(rejected.is_err(), "o banco nem aceita uma regra de origem diferente de 'person'");
    }

    #[test]
    fn o_time_decide_sozinho_por_padrao_e_o_interruptor_liga_e_desliga() {
        let conn = db();
        let t = team(&conn, "tab-lead");
        assert!(store::team(&conn, &t).unwrap().unwrap().auto_decide);
        assert!(store::set_auto_decide(&conn, &t, false).unwrap());
        assert!(!store::team(&conn, &t).unwrap().unwrap().auto_decide);
        assert!(!store::set_auto_decide(&conn, "nao-existe", false).unwrap());
        assert!(store::set_auto_decide(&conn, &t, true).unwrap());
        assert!(store::team_joined_by(&conn, "x").unwrap().is_none());
    }
}

#[test]
fn nenhum_comando_de_cli_nem_de_mcp_escreve_regra_de_permissao() {
    // Só a pessoa, pela tela (comandos Tauri), cria, muda ou apaga regras e liga o «decidir sozinho».
    for (name, source) in [
        ("ipc/commands/dispatch.rs", include_str!("../ipc/commands/dispatch.rs")),
        ("ipc/mcp.rs", include_str!("../ipc/mcp.rs")),
        ("bin/cli.rs", include_str!("../bin/cli.rs")),
        ("ipc/commands/team.rs", include_str!("../ipc/commands/team.rs")),
        ("ipc/commands/peers.rs", include_str!("../ipc/commands/peers.rs")),
    ] {
        for forbidden in ["add_rule(", "update_rule(", "remove_rule(", "set_auto_decide(", "chat_permission_rule", "chat_team_auto_decide"] {
            assert!(!source.contains(forbidden), "{name} não pode mexer em regras de permissão ({forbidden})");
        }
    }
}
