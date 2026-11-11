//! Varredura das skills que o Claude Code acha no disco. Só o frontmatter do SKILL.md é lido;
//! nada aqui executa código de skill nem lê credenciais.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;
use uuid::Uuid;

use super::agent_scan::{scan_claude_skills, AgentSkillScope};

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
