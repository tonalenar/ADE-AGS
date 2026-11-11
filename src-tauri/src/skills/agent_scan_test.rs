//! Varredura das skills que o Claude Code acha no disco. Só o frontmatter do SKILL.md é lido;
//! nada aqui executa código de skill nem lê credenciais.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;
use uuid::Uuid;

use std::collections::HashMap;

use rusqlite::Connection;

use super::agent_scan::{account_env_for_thread, scan_agent_skills, scan_claude_skills, AgentSkill, AgentSkillScope, SkillEnv};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-agent-scan-{}-{}", label, Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// Uma pasta `<root>/<folder>/SKILL.md` com `name` e `description` no frontmatter.
fn skill(root: &Path, folder: &str, description: &str) {
    write(&root.join(folder).join("SKILL.md"), &format!("---\nname: {folder}\ndescription: {description}\n---\n\nCorpo.\n"));
}

/// Um plugin instalado (registro, manifesto e uma skill em `skills/`) sob o diretório de plugins de `home`.
fn plugin(home: &Path, key: &str, prefix: &str, skill_folder: &str, description: &str) {
    let install = home.join("plugins").join("cache").join(prefix);
    skill(&install.join("skills"), skill_folder, description);
    write(&install.join(".claude-plugin").join("plugin.json"), &json!({ "name": prefix }).to_string());
    let registry = json!({ "version": 2, "plugins": { key: [{ "scope": "user", "installPath": install }] } });
    write(&home.join("plugins").join("installed_plugins.json"), &registry.to_string());
}

fn enable(home: &Path, enabled: serde_json::Value) {
    write(&home.join("settings.json"), &json!({ "enabledPlugins": enabled }).to_string());
}

#[test]
fn a_skill_do_usuario_e_a_de_projeto_entram_pelo_nome_da_pasta() {
    let home = temp_dir("home");
    let project = temp_dir("projeto");
    skill(&home.join("skills"), "resumo-semanal", "Resume a semana");
    skill(&project.join(".claude").join("skills"), "deploy-app", "Publica o app");

    let found = scan_claude_skills(&home, &home.join("plugins"), Some(&project), None);

    let got: Vec<(&str, AgentSkillScope)> = found.iter().map(|s| (s.name.as_str(), s.scope)).collect();
    assert_eq!(got, [("deploy-app", AgentSkillScope::Project), ("resumo-semanal", AgentSkillScope::User)]);
    assert_eq!(found[0].description.as_deref(), Some("Publica o app"));
    assert_eq!(found[0].plugin, None);
}

#[test]
fn a_skill_de_plugin_habilitado_entra_com_o_prefixo_do_plugin() {
    let home = temp_dir("home");
    plugin(&home, "design@marketplace", "design", "design-critique", "Feedback de usabilidade");
    enable(&home, json!({ "design@marketplace": true }));

    let found = scan_claude_skills(&home, &home.join("plugins"), None, None);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "design:design-critique");
    assert_eq!(found[0].plugin.as_deref(), Some("design"));
    assert_eq!(found[0].scope, AgentSkillScope::Plugin);
}

#[test]
fn plugin_desabilitado_nao_entra() {
    let home = temp_dir("home");
    plugin(&home, "design@marketplace", "design", "design-critique", "Feedback");
    enable(&home, json!({ "design@marketplace": false }));

    assert!(scan_claude_skills(&home, &home.join("plugins"), None, None).is_empty());
}

#[test]
fn skill_so_para_o_agente_e_skill_desligada_nas_configuracoes_ficam_de_fora() {
    let home = temp_dir("home");
    write(
        &home.join("skills").join("interna").join("SKILL.md"),
        "---\nname: interna\ndescription: Uso interno do agente\nuser-invocable: false\n---\n",
    );
    skill(&home.join("skills"), "desligada", "Desligada pelo usuário");
    write(&home.join("settings.json"), &json!({ "skillOverrides": { "desligada": "off" } }).to_string());

    assert!(scan_claude_skills(&home, &home.join("plugins"), None, None).is_empty());
}

#[test]
fn descricao_com_dois_pontos_e_bloco_dobrado_sao_lidas_como_texto() {
    let home = temp_dir("home");
    write(
        &home.join("skills").join("revisao").join("SKILL.md"),
        "---\nname: revisao\ndescription: Use when: the user asks for a review\n---\n",
    );
    write(&home.join("skills").join("longa").join("SKILL.md"), "---\ndescription: >-\n  Primeira linha\n  segunda linha\n---\n");

    let found = scan_claude_skills(&home, &home.join("plugins"), None, None);

    let description = |name: &str| found.iter().find(|s| s.name == name).and_then(|s| s.description.clone());
    assert_eq!(description("revisao").as_deref(), Some("Use when: the user asks for a review"));
    assert_eq!(description("longa").as_deref(), Some("Primeira linha segunda linha"));
}

#[test]
fn a_skill_do_usuario_vence_a_de_projeto_com_o_mesmo_nome() {
    let home = temp_dir("home");
    let project = temp_dir("projeto");
    skill(&home.join("skills"), "deploy-app", "Versão pessoal");
    skill(&project.join(".claude").join("skills"), "deploy-app", "Versão do projeto");

    let found = scan_claude_skills(&home, &home.join("plugins"), Some(&project), None);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].description.as_deref(), Some("Versão pessoal"));
    assert_eq!(found[0].scope, AgentSkillScope::User);
}

#[test]
fn pasta_sem_skill_nome_fora_do_padrao_e_agents_skills_do_projeto_nao_entram() {
    let home = temp_dir("home");
    let project = temp_dir("projeto");
    fs::create_dir_all(home.join("skills").join("sem-arquivo")).unwrap();
    skill(&home.join("skills"), "nome com espaco", "Nome inválido para um comando");
    skill(&project.join(".agents").join("skills"), "do-codex", "Convenção do Codex, não do Claude");

    assert!(scan_claude_skills(&home, &home.join("plugins"), Some(&project), None).is_empty());
}

#[test]
fn um_skill_com_corpo_enorme_continua_legivel_pelo_frontmatter() {
    let home = temp_dir("home");
    let corpo = "linha de instruções\n".repeat(20_000);
    write(
        &home.join("skills").join("grande").join("SKILL.md"),
        &format!("---\ndescription: Corpo grande\n---\n{corpo}"),
    );

    let found = scan_claude_skills(&home, &home.join("plugins"), None, None);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].description.as_deref(), Some("Corpo grande"));
}

// --- Varredura por agente: conta da aba, Codex e agentes sem varredura confirmada ---

/// Ambiente do processo de teste: só as variáveis dadas.
fn process_env(vars: &[(&str, &Path)]) -> impl Fn(&str) -> Option<String> + use<> {
    let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string_lossy().into_owned())).collect();
    move |name: &str| map.get(name).cloned()
}

/// Variáveis da conta da aba, como `accounts` as monta para o provedor.
fn account_env(vars: &[(&str, &Path)]) -> HashMap<String, String> {
    vars.iter().map(|(k, v)| (k.to_string(), v.to_string_lossy().into_owned())).collect()
}

fn names_of(found: &[AgentSkill]) -> Vec<&str> {
    found.iter().map(|s| s.name.as_str()).collect()
}

#[test]
fn codex_le_a_pasta_da_conta_os_agents_do_projeto_e_os_do_usuario() {
    let root = temp_dir("codex-conta");
    let home = root.join("home");
    let codex_da_conta = root.join("conta-codex");
    let project = root.join("projeto");
    fs::create_dir_all(project.join(".git")).unwrap();
    skill(&codex_da_conta.join("skills"), "da-conta", "Vem da conta do Codex");
    skill(&project.join(".agents").join("skills"), "do-projeto", "Vem do projeto");
    skill(&home.join(".agents").join("skills"), "do-usuario", "Vem do home");
    // O CODEX_HOME do processo da ADE não vale quando a aba tem conta: o Codex dela lê outra pasta.
    skill(&root.join("codex-do-processo").join("skills"), "do-processo", "Não deve aparecer");
    let account = account_env(&[("CODEX_HOME", codex_da_conta.as_path())]);
    let process = process_env(&[("CODEX_HOME", root.join("codex-do-processo").as_path()), ("HOME", home.as_path())]);
    let env = SkillEnv { account: Some(&account), process: &process, cwd: Some(&project), managed_settings: None };

    let found = scan_agent_skills("codex", &env);

    let got: Vec<(&str, AgentSkillScope)> = found.iter().map(|s| (s.name.as_str(), s.scope)).collect();
    assert_eq!(
        got,
        [("da-conta", AgentSkillScope::User), ("do-projeto", AgentSkillScope::Project), ("do-usuario", AgentSkillScope::User)]
    );
}

#[test]
fn codex_sobe_do_cwd_ate_a_raiz_do_repositorio_e_nao_passa_dela() {
    let root = temp_dir("codex-repo");
    let repo = root.join("repo");
    let cwd = repo.join("pacote").join("sub");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    skill(&cwd.join(".agents").join("skills"), "perto", "Do subprojeto");
    skill(&repo.join("pacote").join(".agents").join("skills"), "meio", "Do pacote");
    skill(&repo.join(".agents").join("skills"), "raiz", "Da raiz do repositório");
    // Acima da raiz do repositório o Codex não procura.
    skill(&root.join(".agents").join("skills"), "fora", "Acima do repositório");
    let process = process_env(&[("HOME", root.join("sem-skills").as_path())]);
    let env = SkillEnv { account: None, process: &process, cwd: Some(&cwd), managed_settings: None };

    let found = scan_agent_skills("codex", &env);

    assert_eq!(names_of(&found), ["meio", "perto", "raiz"]);
}

#[test]
fn codex_sem_conta_le_o_codex_home_do_processo() {
    let root = temp_dir("codex-processo");
    skill(&root.join("codex").join("skills"), "do-processo", "Do CODEX_HOME do processo");
    let process = process_env(&[("CODEX_HOME", root.join("codex").as_path()), ("HOME", root.join("home").as_path())]);
    let env = SkillEnv { account: None, process: &process, cwd: None, managed_settings: None };

    let found = scan_agent_skills("codex", &env);

    assert_eq!(names_of(&found), ["do-processo"]);
}

#[test]
fn claude_com_conta_le_o_config_dir_da_conta_e_nao_o_do_processo() {
    let root = temp_dir("claude-conta");
    skill(&root.join("conta-a").join("skills"), "da-conta", "Da conta A");
    skill(&root.join("processo").join("skills"), "do-processo", "Do processo da ADE");
    let account = account_env(&[("CLAUDE_CONFIG_DIR", root.join("conta-a").as_path())]);
    let process = process_env(&[("CLAUDE_CONFIG_DIR", root.join("processo").as_path()), ("HOME", root.join("home").as_path())]);
    let env = SkillEnv { account: Some(&account), process: &process, cwd: None, managed_settings: None };

    let found = scan_agent_skills("claude-code", &env);

    assert_eq!(names_of(&found), ["da-conta"]);
}

#[test]
fn agentes_sem_varredura_confirmada_nao_mostram_skill_no_menu() {
    let root = temp_dir("sem-varredura");
    let project = root.join("projeto");
    for folder in [".agents/skills", ".cursor/skills", ".opencode/skills", ".gemini/skills"] {
        skill(&project.join(folder), "deploy", "Publica o app");
    }
    let process = process_env(&[("HOME", root.join("home").as_path())]);
    for agent in ["opencode", "cursor", "antigravity", "hermes", "gemini-cli", "kimi-code", "local-acp-x"] {
        let env = SkillEnv { account: None, process: &process, cwd: Some(&project), managed_settings: None };
        assert!(scan_agent_skills(agent, &env).is_empty(), "{agent}: sem varredura confirmada, o menu não mostra skill");
    }
}

#[test]
fn a_conta_da_aba_so_vale_quando_e_do_mesmo_provedor_e_ainda_existe() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE chat_thread (id TEXT PRIMARY KEY, account_id TEXT);
         CREATE TABLE agent_accounts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, dir TEXT NOT NULL, kind TEXT, base_url TEXT);
         INSERT INTO agent_accounts VALUES ('conta-1', 'claude-code', '/contas/claude-1', 'subscription', NULL);
         INSERT INTO chat_thread VALUES ('aba-com-conta', 'conta-1'), ('aba-sem-conta', NULL);",
    )
    .unwrap();

    let env = account_env_for_thread(&conn, "aba-com-conta", "claude-code").expect("a conta do Claude");
    assert_eq!(env.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some("/contas/claude-1"));
    assert!(account_env_for_thread(&conn, "aba-com-conta", "codex").is_none(), "conta de outro provedor não vale");
    assert!(account_env_for_thread(&conn, "aba-sem-conta", "claude-code").is_none());
    assert!(account_env_for_thread(&conn, "aba-inexistente", "claude-code").is_none());
}
