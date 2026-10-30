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
    let me = model::Named { name: "Codex", agent: "codex", role: "Frontend", policy: Policy::Edits, branch: Some("team/ui") };
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
