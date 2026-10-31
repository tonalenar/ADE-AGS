//! A injeção do ai-memory na conversa do Claude por protocolo, sem agente nem ai-memory reais: o binário é um
//! caminho qualquer (só vai escrito no MCP), e os arquivos ficam numa pasta temporária.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::claude_map::{launch_args, Start};
use super::memoria::{config_id, prepare, Inputs, Memory};
use super::store::ThreadRow;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ade-conversa-memoria-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("home/.claude")).unwrap();
        Self(root)
    }
    fn mcp(&self) -> PathBuf {
        self.0.join("mcp")
    }
    fn home(&self) -> PathBuf {
        self.0.join("home")
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn row() -> ThreadRow {
    ThreadRow {
        id: "abc-123".into(), agent_id: "claude-code".into(), remote_id: None, cwd: "/p".into(), title: String::new(),
        model: Some("sonnet".into()), effort: None, access: "ask".into(), account_id: None, memory: None,
        state: "active".into(), created_at: 1, updated_at: 1,
    }
}

fn run(root: &Root, enabled: bool, binary: Option<&str>, argv: &[String]) -> Memory {
    let extras = HashMap::new();
    prepare(Inputs {
        enabled,
        binary: binary.map(PathBuf::from),
        thread_id: "abc-123",
        dir: &root.mcp(),
        home: &root.home(),
        argv,
        extras: &extras,
    })
}

fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn claude_argv() -> Vec<String> {
    let mut argv = vec!["claude".to_string()];
    argv.extend(launch_args(&row(), Start::New("s-1")));
    argv
}

#[test]
fn o_nome_da_conversa_vira_um_arquivo_seguro_e_proprio() {
    assert_eq!(crate::ipc::mcp::tab_config_name(&config_id("abc-123")), "tab-thread-abc-123");
    let hostil = crate::ipc::mcp::tab_config_name(&config_id("../../etc/passwd"));
    assert!(hostil.starts_with("tab-thread-") && !hostil.contains('/') && !hostil.contains('.'), "{hostil}");
}

#[test]
fn a_conversa_nasce_com_os_hooks_e_o_mcp_do_ai_memory() {
    let root = Root::new();
    let memory = run(&root, true, Some("/opt/ai-memory"), &claude_argv());
    assert_eq!(memory.state, "on");
    assert!(memory.notice.is_none());

    let mcp = value_of(&memory.args, "--mcp-config").expect("falta --mcp-config");
    assert_eq!(Path::new(mcp), root.mcp().join("tab-thread-abc-123.json"));
    let config: serde_json::Value = serde_json::from_slice(&fs::read(mcp).unwrap()).unwrap();
    assert_eq!(config["mcpServers"]["ai-memory"]["command"], "/opt/ai-memory");
    assert_eq!(config["mcpServers"]["ai-memory"]["args"][0], "mcp-bridge");

    let settings = value_of(&memory.args, "--settings").expect("falta --settings");
    assert!(Path::new(settings).file_name().unwrap().to_string_lossy().starts_with("tab-thread-abc-123.ai-memory-"));
    let hooks: serde_json::Value = serde_json::from_slice(&fs::read(settings).unwrap()).unwrap();
    assert!(hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str().unwrap().contains("hook --event session-start"));
    assert_eq!(memory.args.iter().filter(|a| *a == "--settings").count(), 1);
    assert_eq!(memory.args.iter().filter(|a| *a == "--mcp-config").count(), 1);
}

#[test]
fn o_ambiente_do_filho_nunca_deixa_o_autowire_reescrever_a_configuracao() {
    let root = Root::new();
    for (enabled, binary) in [(true, Some("/opt/ai-memory")), (false, Some("/opt/ai-memory")), (true, None)] {
        let memory = run(&root, enabled, binary, &claude_argv());
        assert!(memory.env.contains(&("AI_MEMORY_RUN_AUTOWIRE".to_string(), "false".to_string())), "{enabled} {binary:?}");
    }
}

#[test]
fn o_arquivo_temporario_some_quando_a_conversa_solta_a_injecao() {
    let root = Root::new();
    let memory = run(&root, true, Some("/opt/ai-memory"), &claude_argv());
    let settings = PathBuf::from(value_of(&memory.args, "--settings").unwrap());
    assert!(settings.exists());
    drop(memory);
    assert!(!settings.exists(), "o arquivo dos hooks não pode vazar");
}

#[test]
fn reabrir_reinjeta_e_o_arquivo_anterior_some_sem_duplicar_o_servidor() {
    let root = Root::new();
    let first = run(&root, true, Some("/opt/ai-memory"), &claude_argv());
    let old = PathBuf::from(value_of(&first.args, "--settings").unwrap());
    // Troca de modelo/acesso: o processo novo nasce antes de o antigo ser solto.
    let second = run(&root, true, Some("/opt/ai-memory"), &claude_argv());
    let new = PathBuf::from(value_of(&second.args, "--settings").unwrap());
    assert_ne!(old, new);
    drop(first);
    assert!(!old.exists() && new.exists());
    let config: serde_json::Value = serde_json::from_slice(&fs::read(root.mcp().join("tab-thread-abc-123.json")).unwrap()).unwrap();
    assert_eq!(config["mcpServers"].as_object().unwrap().len(), 1);
}

#[test]
fn settings_explicito_no_comando_nao_e_substituido() {
    let root = Root::new();
    let mut argv = claude_argv();
    argv.extend(["--settings".into(), "/meu/settings.json".into()]);
    let memory = run(&root, true, Some("/opt/ai-memory"), &argv);
    assert!(!memory.args.iter().any(|a| a == "--settings"), "{:?}", memory.args);
    assert!(memory.args.iter().any(|a| a == "--mcp-config"));
    assert_eq!(memory.state, "on");
    let mut argv = claude_argv();
    argv.push("--settings=/meu/settings.json".into());
    assert!(!run(&root, true, Some("/opt/ai-memory"), &argv).args.iter().any(|a| a == "--settings"));
}

#[test]
fn hooks_do_ai_memory_que_o_usuario_ja_tem_nao_sao_duplicados() {
    let root = Root::new();
    fs::write(
        root.home().join(".claude/settings.json"),
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"ai-memory hook --event session-start"}]}]}}"#,
    )
    .unwrap();
    let memory = run(&root, true, Some("/opt/ai-memory"), &claude_argv());
    assert!(!memory.args.iter().any(|a| a == "--settings"));
    assert!(memory.args.iter().any(|a| a == "--mcp-config"), "o MCP continua: só os hooks eram dele");
}

#[test]
fn o_ajuste_desligado_nao_injeta_e_tira_o_servidor_que_ficou() {
    let root = Root::new();
    drop(run(&root, true, Some("/opt/ai-memory"), &claude_argv()));
    let memory = run(&root, false, Some("/opt/ai-memory"), &claude_argv());
    assert!(memory.args.is_empty());
    assert_eq!(memory.state, "off:disabled");
    let config: serde_json::Value = serde_json::from_slice(&fs::read(root.mcp().join("tab-thread-abc-123.json")).unwrap()).unwrap();
    assert!(config["mcpServers"].get("ai-memory").is_none(), "{config}");
}

#[test]
fn sem_ai_memory_aceito_a_conversa_abre_sem_memoria_e_sem_aviso() {
    let root = Root::new();
    let memory = run(&root, true, None, &claude_argv());
    assert!(memory.args.is_empty());
    assert_eq!(memory.state, "off:unavailable");
    assert!(memory.notice.is_none(), "quem não tem o ai-memory não quer um aviso em toda conversa");
}

#[test]
fn falha_ao_gravar_os_arquivos_nao_impede_abrir_e_avisa() {
    let root = Root::new();
    // A pasta do MCP é um arquivo: não dá para criar nem gravar nela.
    fs::write(root.mcp(), "não sou uma pasta").unwrap();
    let memory = run(&root, true, Some("/opt/ai-memory"), &claude_argv());
    assert!(memory.args.is_empty());
    assert_eq!(memory.state, "off:failed");
    let notice = memory.notice.expect("falha inesperada tem aviso");
    assert!(notice.contains("ai-memory"), "{notice}");
}

#[test]
fn os_argumentos_finais_do_claude_somam_os_da_memoria_sem_mexer_nos_da_conversa() {
    let root = Root::new();
    let base = launch_args(&row(), Start::New("s-1"));
    let memory = run(&root, true, Some("/opt/ai-memory"), &claude_argv());
    let mut finais = base.clone();
    finais.extend(memory.args.clone());
    assert_eq!(&finais[..base.len()], &base[..]);
    assert_eq!(finais.iter().filter(|a| *a == "--permission-prompt-tool").count(), 1);
    assert_eq!(finais.iter().filter(|a| *a == "--settings").count(), 1);
}

#[test]
fn a_varredura_limpa_o_que_a_conversa_deixa_e_poupa_a_que_existe() {
    let root = Root::new();
    let dir = root.mcp();
    fs::create_dir_all(&dir).unwrap();
    for name in [
        "tab-thread-viva.json",
        "tab-thread-morta.json",
        "tab-thread-viva.ai-memory-1.settings.json",
        "tab-thread-morta.ai-memory-2.settings.json",
        "tab-aba.json",
    ] {
        fs::write(dir.join(name), "{}").unwrap();
    }
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE tabs(id TEXT); CREATE TABLE tasks(id TEXT); CREATE TABLE chat_thread(id TEXT); INSERT INTO tabs VALUES ('aba'); INSERT INTO chat_thread VALUES ('viva');").unwrap();
    // Os hooks de uma conversa só valem com o processo vivo (no arranque do app, nenhum): saem os dois arquivos deles
    // e o MCP da conversa que não existe mais.
    assert_eq!(crate::ipc::mcp::sweep_configs_in(&dir, &conn), 3);
    let mut ficaram: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    ficaram.sort();
    assert_eq!(ficaram, ["tab-aba.json", "tab-thread-viva.json"]);
    assert_eq!(crate::ipc::mcp::sweep_configs_in(&dir, &conn), 0, "idempotente");
}

#[test]
fn o_estado_da_memoria_fica_gravado_na_conversa_e_vai_para_a_tela() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    super::store::migrate(&conn).unwrap();
    super::store::migrate(&conn).unwrap(); // aditiva e idempotente
    let tuning = super::store::Tuning { model: None, effort: None, access: "ask".into() };
    let thread = super::store::insert_thread(&conn, "t1", "claude-code", "/p", "T", &tuning, None, 1).unwrap();
    assert_eq!(thread.memory, None, "antes de o processo abrir não há o que dizer");
    super::store::set_memory(&conn, "t1", "off:unavailable").unwrap();
    let thread = super::store::thread(&conn, "t1").unwrap().unwrap();
    assert_eq!(thread.memory.as_deref(), Some("off:unavailable"));
    assert_eq!(serde_json::to_value(&thread).unwrap()["memory"], "off:unavailable");
}

/// O roteiro de ponta a ponta com o `claude` e o `ai-memory` de verdade (cota e rede reais: só à mão).
#[test]
#[ignore = "precisa de claude e ai-memory reais"]
fn ponta_a_ponta_a_conversa_por_protocolo_grava_sessao_no_ai_memory() {
    // 1. `ai-memory serve` rodando e `AI_MEMORY_EMBEDDING_PROVIDER=none` só para ler.
    // 2. Abrir uma conversa nova do Claude Code no modo chat e mandar: "Resuma em uma frase o que este projeto faz."
    // 3. Esperar o fim do turno: o Resumo → Conectores mostra «ai-memory ligado».
    // 4. `ai-memory recent --json` lista a sessão/página da pasta da conversa; o painel Memória das Configurações a mostra.
    // 5. Fechar a conversa: o `tab-thread-<id>.ai-memory-*.settings.json` some de `~/.ags/mcp`.
    unimplemented!("roteiro manual; ver docs/ade-ags/AI_MEMORY_CONNECTOR.md");
}
