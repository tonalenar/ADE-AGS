use std::sync::{Arc, Mutex};

use super::*;
use crate::runs::quota::{self, Quota};

fn choice(agent: &str, model: Option<&str>) -> ModelChoice {
    ModelChoice { agent_id: agent.into(), model: model.map(str::to_owned) }
}

fn defaults(cwd: &str) -> ProjectChatDefaults {
    ProjectChatDefaults { cwd: cwd.into(), ..Default::default() }
}

/// Um limitador falso: só os agentes da lista estão sem limite, até 9_000.
fn limited<'a>(agents: &'a [&'a str]) -> impl Fn(&str) -> Option<i64> + 'a {
    move |agent| agents.contains(&agent).then_some(9_000)
}

#[test]
fn o_projeto_precisa_de_caminho_absoluto() {
    let erro = validate(defaults("relativo/app")).unwrap_err();
    assert!(erro.contains("absoluto"), "{erro}");
    assert!(validate(defaults("")).is_err());
}

#[test]
fn normaliza_a_pasta_e_o_modelo() {
    let ok = validate(ProjectChatDefaults {
        cwd: "C:\\Users\\ton\\app\\".into(),
        primary: Some(choice("codex", Some("  gpt-6.1-sol  "))),
        fallback: Some(choice("claude-code", Some("   "))),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(ok.cwd, "C:/Users/ton/app");
    assert_eq!(ok.primary.unwrap().model.as_deref(), Some("gpt-6.1-sol"));
    // Modelo só de espaços é «o padrão do agente».
    assert_eq!(ok.fallback.unwrap().model, None);
}

#[test]
fn recusa_permissao_workspace_e_agente_invalidos() {
    let base = || defaults("/p/app");
    assert!(validate(ProjectChatDefaults { access: Some("tudo".into()), ..base() }).is_err());
    assert!(validate(ProjectChatDefaults { workspace: Some("nuvem".into()), ..base() }).is_err());
    assert!(validate(ProjectChatDefaults { primary: Some(choice("co dex", None)), ..base() }).is_err());
    assert!(validate(ProjectChatDefaults { primary: Some(choice("codex", Some("a\nb"))), ..base() }).is_err());
    for access in ["ask", "safe", "edits", "full"] {
        assert!(validate(ProjectChatDefaults { access: Some(access.into()), ..base() }).is_ok(), "{access}");
    }
    for workspace in ["local", "worktree"] {
        assert!(validate(ProjectChatDefaults { workspace: Some(workspace.into()), ..base() }).is_ok(), "{workspace}");
    }
}

#[test]
fn o_reserva_nao_pode_ser_igual_ao_principal() {
    let igual = ProjectChatDefaults {
        primary: Some(choice("codex", Some("m1"))),
        fallback: Some(choice("codex", Some("m1"))),
        ..defaults("/p/app")
    };
    assert!(validate(igual).unwrap_err().contains("diferente"));
    let outro_modelo = ProjectChatDefaults {
        primary: Some(choice("codex", Some("m1"))),
        fallback: Some(choice("codex", Some("m2"))),
        ..defaults("/p/app")
    };
    assert!(validate(outro_modelo).is_ok());
}

#[test]
fn grava_le_e_apaga_sem_tocar_nos_outros_projetos() {
    let conn = crate::database::test_db();
    let a = ProjectChatDefaults {
        primary: Some(choice("codex", Some("m1"))),
        fallback: Some(choice("claude-code", None)),
        workspace: Some("worktree".into()),
        access: Some("edits".into()),
        ..defaults("/p/a")
    };
    let b = ProjectChatDefaults { access: Some("ask".into()), ..defaults("/p/b") };
    write(&conn, a.clone()).unwrap();
    write(&conn, b.clone()).unwrap();

    assert_eq!(read(&conn, "/p/a/").unwrap(), Some(a));
    assert_eq!(read(&conn, "/p/b").unwrap(), Some(b.clone()));
    assert_eq!(read(&conn, "/p/c").unwrap(), None);

    // Registro vazio apaga a chave («Redefinir»), e o outro projeto fica.
    assert_eq!(write(&conn, defaults("/p/a")).unwrap(), None);
    assert_eq!(read(&conn, "/p/a").unwrap(), None);
    assert_eq!(read(&conn, "/p/b").unwrap(), Some(b));
    remove(&conn, "/p/b").unwrap();
    assert_eq!(read(&conn, "/p/b").unwrap(), None);
}

#[test]
fn gravar_de_novo_substitui_o_registro() {
    let conn = crate::database::test_db();
    write(&conn, ProjectChatDefaults { access: Some("full".into()), workspace: Some("local".into()), ..defaults("/p/a") }).unwrap();
    write(&conn, ProjectChatDefaults { access: Some("safe".into()), ..defaults("/p/a") }).unwrap();
    let lido = read(&conn, "/p/a").unwrap().unwrap();
    assert_eq!(lido.access.as_deref(), Some("safe"));
    assert_eq!(lido.workspace, None);
}

#[test]
fn a_lista_traz_todos_e_ignora_registro_ilegivel() {
    let conn = crate::database::test_db();
    write(&conn, ProjectChatDefaults { access: Some("ask".into()), ..defaults("/p/a") }).unwrap();
    write(&conn, ProjectChatDefaults { access: Some("safe".into()), ..defaults("/p/b") }).unwrap();
    // Um registro editado à mão e outro de outra família de chaves.
    conn.execute("INSERT INTO settings (key, value) VALUES (?1, 'isto não é json')", [format!("{SETTINGS_PREFIX}zzzz")]).unwrap();
    conn.execute("INSERT INTO settings (key, value) VALUES ('chat.project.disabled-agents.v1.x', '{}')", []).unwrap();
    let mut cwds: Vec<String> = read_all(&conn).unwrap().into_iter().map(|d| d.cwd).collect();
    cwds.sort();
    assert_eq!(cwds, ["/p/a", "/p/b"]);
}

#[test]
fn um_registro_que_nao_e_deste_projeto_nao_vale() {
    let conn = crate::database::test_db();
    // Registro de /p/a gravado na chave de /p/b.
    let alheio = serde_json::to_string(&ProjectChatDefaults { access: Some("full".into()), ..defaults("/p/a") }).unwrap();
    conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", rusqlite::params![setting_key("/p/b"), alheio]).unwrap();
    assert!(read(&conn, "/p/b").is_err());
}

#[test]
fn um_worktree_temporario_usa_os_padroes_do_projeto_de_origem() {
    let db: DbConnection = Arc::new(Mutex::new(crate::database::test_db()));
    crate::project_chat_policy::register_worktree_alias(&db, "/wt/app-1", "/p/app").unwrap();
    let conn = db.lock().unwrap();
    write(&conn, ProjectChatDefaults { access: Some("edits".into()), ..defaults("/p/app") }).unwrap();
    let lido = read(&conn, "/wt/app-1").unwrap().unwrap();
    assert_eq!(lido.cwd, "/p/app");
    assert_eq!(lido.access.as_deref(), Some("edits"));
}

// ── O modelo reserva ──────────────────────────────────────────────────────────────────────────────────────

fn com_reserva() -> ProjectChatDefaults {
    ProjectChatDefaults {
        primary: Some(choice("codex", Some("m1"))),
        fallback: Some(choice("claude-code", Some("opus"))),
        ..defaults("/p/app")
    }
}

#[test]
fn sem_limite_vale_o_principal() {
    let escolha = effective(&com_reserva(), &limited(&[])).unwrap();
    assert_eq!((escolha.agent_id.as_str(), escolha.model.as_deref()), ("codex", Some("m1")));
    assert!(!escolha.used_fallback);
    assert_eq!(escolha.limited_until, None);
}

#[test]
fn principal_sem_limite_entra_o_reserva_livre() {
    let escolha = effective(&com_reserva(), &limited(&["codex"])).unwrap();
    assert_eq!((escolha.agent_id.as_str(), escolha.model.as_deref()), ("claude-code", Some("opus")));
    assert!(escolha.used_fallback);
    assert_eq!(escolha.limited_until, Some(9_000));
}

#[test]
fn se_o_reserva_tambem_esta_sem_limite_fica_o_principal_e_avisa() {
    let escolha = effective(&com_reserva(), &limited(&["codex", "claude-code"])).unwrap();
    assert_eq!(escolha.agent_id, "codex");
    assert!(!escolha.used_fallback);
    assert_eq!(escolha.limited_until, Some(9_000));
}

#[test]
fn sem_reserva_o_principal_sem_limite_continua_mas_avisa() {
    let sem_reserva = ProjectChatDefaults { fallback: None, ..com_reserva() };
    let escolha = effective(&sem_reserva, &limited(&["codex"])).unwrap();
    assert!(!escolha.used_fallback);
    assert_eq!(escolha.limited_until, Some(9_000));
}

#[test]
fn sem_principal_nao_ha_escolha() {
    let so_reserva = ProjectChatDefaults { primary: None, ..com_reserva() };
    assert_eq!(effective(&so_reserva, &limited(&["codex"])), None);
}

#[test]
fn o_sinal_de_limite_e_o_que_a_frota_ja_grava() {
    let db: DbConnection = Arc::new(Mutex::new(crate::database::test_db()));
    // A conta principal do Codex foi rejeitada até 9_000; a do Claude está livre.
    quota::record(&db, &quota::account_key("codex", None), Quota { rejected: true, rejected_until: Some(9_000), ..Quota::default() }, 1_000);
    let conn = db.lock().unwrap();
    write(&conn, com_reserva()).unwrap();
    let defaults = read(&conn, "/p/app").unwrap().unwrap();

    let antes = limited_probe(&conn, None, 2_000);
    let escolha = effective(&defaults, &antes).unwrap();
    assert!(escolha.used_fallback);
    assert_eq!(escolha.limited_until, Some(9_000));

    // Passada a hora de renovar, o principal volta sozinho.
    let depois = limited_probe(&conn, None, 9_001);
    assert!(!effective(&defaults, &depois).unwrap().used_fallback);

    // Outra conta (id próprio) tem o sinal dela: a principal esgotada não vale para ela.
    let outra = limited_probe(&conn, Some("conta-b"), 2_000);
    assert!(!effective(&defaults, &outra).unwrap().used_fallback);
}

// ── Quem abre conversa sem tela ───────────────────────────────────────────────────────────────────────────

#[test]
fn sem_padroes_vale_o_pedido() {
    let (agente, modelo) = inherit_for_agent_open(None, Some("gemini-cli"), Some("x"), &limited(&[]));
    assert_eq!((agente.as_deref(), modelo.as_deref()), (Some("gemini-cli"), Some("x")));
}

#[test]
fn sem_agente_pedido_herda_o_agente_e_o_modelo_do_projeto() {
    let (agente, modelo) = inherit_for_agent_open(Some(&com_reserva()), None, None, &limited(&[]));
    assert_eq!((agente.as_deref(), modelo.as_deref()), (Some("codex"), Some("m1")));
}

#[test]
fn o_agente_pedido_igual_ao_principal_herda_o_modelo() {
    let (agente, modelo) = inherit_for_agent_open(Some(&com_reserva()), Some("codex"), None, &limited(&[]));
    assert_eq!((agente.as_deref(), modelo.as_deref()), (Some("codex"), Some("m1")));
}

#[test]
fn o_modelo_pedido_sempre_vale() {
    let (agente, modelo) = inherit_for_agent_open(Some(&com_reserva()), Some("codex"), Some("meu"), &limited(&[]));
    assert_eq!((agente.as_deref(), modelo.as_deref()), (Some("codex"), Some("meu")));
}

#[test]
fn outro_agente_pedido_nao_herda_o_modelo_do_projeto() {
    let (agente, modelo) = inherit_for_agent_open(Some(&com_reserva()), Some("opencode"), None, &limited(&[]));
    assert_eq!((agente.as_deref(), modelo.as_deref()), (Some("opencode"), None));
}

#[test]
fn com_o_principal_sem_limite_a_conversa_aberta_por_agente_usa_o_reserva() {
    let (agente, modelo) = inherit_for_agent_open(Some(&com_reserva()), None, None, &limited(&["codex"]));
    assert_eq!((agente.as_deref(), modelo.as_deref()), (Some("claude-code"), Some("opus")));
}

#[test]
fn a_permissao_e_o_workspace_do_projeto_nao_entram_na_heranca() {
    // O contrato da função: só devolve agente e modelo. Conversa aberta por agente começa supervisionada.
    let com_permissao = ProjectChatDefaults { access: Some("full".into()), workspace: Some("worktree".into()), ..com_reserva() };
    let (agente, modelo) = inherit_for_agent_open(Some(&com_permissao), None, None, &limited(&[]));
    assert_eq!((agente.as_deref(), modelo.as_deref()), (Some("codex"), Some("m1")));
}
