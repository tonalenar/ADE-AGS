use std::fs;

use super::tarefas_saida::{find_task_output, read_redirected_output, read_task_output, redirect_targets};

#[test]
fn le_a_saida_viva_do_arquivo_temporario_do_claude() {
    let root = std::env::temp_dir().join(format!("ade-task-output-{}", uuid::Uuid::new_v4()));
    let path = root
        .join("claude-501")
        .join("projeto")
        .join("sessao-1")
        .join("tasks")
        .join("tarefa-1.output");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "compilando\nPASS 12 testes\n").unwrap();

    let found = find_task_output(&root.join("claude-501"), "sessao-1", "tarefa-1")
        .expect("arquivo da tarefa");
    let output = read_task_output(&found).expect("saída da tarefa");
    assert_eq!(output["output"], "compilando\nPASS 12 testes\n");
    assert_eq!(output["total_bytes"], 26);
    assert_eq!(output["truncated"], false);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn acha_os_logs_para_onde_o_comando_manda_a_saida() {
    let cwd = std::path::Path::new("/projeto");
    let alvos = |c: &str| redirect_targets(c, cwd).into_iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert_eq!(alvos("cd /p; npx expo start > /tmp/metro.log 2>&1"), vec!["/tmp/metro.log"]);
    assert_eq!(alvos("LANG=en_US.UTF-8 eas build --local &>/tmp/eas-local.log"), vec!["/tmp/eas-local.log"]);
    assert_eq!(alvos("npm test 2>&1 | tee -a logs/test.log"), vec!["/projeto/logs/test.log"]);
    assert_eq!(alvos("echo oi >> 'saida com espaço.txt'"), vec!["/projeto/saida com espaço.txt"]);
    assert!(alvos("make 2>&1 >/dev/null").is_empty());
    assert!(alvos("sleep 90; grep -v x /tmp/eas-local.log | tail -15").is_empty());
}

#[test]
fn le_o_log_redirecionado_quando_o_arquivo_da_tarefa_fica_vazio() {
    let dir = std::env::temp_dir().join(format!("ade-task-redir-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("metro.log"), "Metro waiting on exp://192.168.1.38:8081\n").unwrap();
    let out = read_redirected_output("npx expo start --lan > metro.log 2>&1", &dir).expect("saída do log");
    assert_eq!(out["output"], "Metro waiting on exp://192.168.1.38:8081\n");
    assert!(out["source"].as_str().unwrap().ends_with("metro.log"));
    assert!(read_redirected_output("npx expo start > nao-existe.log", &dir).is_none());
    fs::remove_dir_all(&dir).ok();
}
