use std::fs;

use super::tarefas_saida::{find_task_output, read_task_output};

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
