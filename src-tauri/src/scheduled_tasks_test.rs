//! Testes do sidecar de tarefas agendadas: teto do histórico, gravação só quando algo muda, arquivo inválido e a
//! reivindicação do horário antes do dispatch. Tudo numa pasta temporária; nunca toca `~/.ags`.

use std::path::PathBuf;

use chrono::{Local, TimeZone};

use super::*;

fn dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ags-tarefas-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(n: usize) -> TaskRun {
    TaskRun {
        id: format!("run-{n}"),
        task_id: "t".into(),
        cwd: String::new(),
        agent_id: String::new(),
        model: None,
        scheduled_for: None,
        scheduled_at: n as i64,
        finished_at: None,
        status: "dispatched".into(),
        thread_id: None,
        result: String::new(),
    }
}

fn task(schedule: Schedule, next_run: Option<i64>) -> ScheduledTask {
    ScheduledTask {
        id: "t".into(),
        name: "Tarefa".into(),
        prompt: "oi".into(),
        agent_id: "codex".into(),
        model: None,
        effort: None,
        cwd: "/repo".into(),
        workspace_id: None,
        existing_thread_id: None,
        access: "ask".into(),
        schedule,
        enabled: true,
        next_run,
        armed_at_ms: 0,
        created_at: 0,
        updated_at: 0,
        history: Vec::new(),
    }
}

fn at(secs: i64) -> DateTime<Local> {
    Local.timestamp_opt(secs, 0).unwrap()
}

#[test]
fn o_historico_guarda_so_as_ultimas_200_execucoes() {
    let mut t = task(Schedule::Every { secs: 300 }, None);
    for n in 0..(MAX_HISTORY + 50) {
        push_history(&mut t, run(n));
    }
    assert_eq!(t.history.len(), MAX_HISTORY);
    assert_eq!(t.history.first().unwrap().id, "run-50");
    assert_eq!(t.history.last().unwrap().id, format!("run-{}", MAX_HISTORY + 49));
}

#[test]
fn arquivo_antigo_acima_do_teto_encolhe_na_proxima_gravacao() {
    let path = dir().join("scheduled-tasks.json");
    let mut t = task(Schedule::Every { secs: 300 }, None);
    t.history = (0..300).map(run).collect();
    let body = serde_json::to_vec_pretty(&TasksFile { version: FILE_VERSION, tasks: vec![t] }).unwrap();
    std::fs::write(&path, body).unwrap();
    update_at(&path, |_| Ok(())).unwrap();
    let (file, _) = read_file_at(&path).unwrap();
    assert_eq!(file.tasks[0].history.len(), MAX_HISTORY);
}

#[cfg(unix)]
#[test]
fn atualizar_sem_mudar_nada_nao_regrava_o_arquivo() {
    use std::os::unix::fs::MetadataExt;
    let path = dir().join("scheduled-tasks.json");
    update_at(&path, |tasks| {
        tasks.push(task(Schedule::Every { secs: 300 }, None));
        Ok(())
    })
    .unwrap();
    let antes = std::fs::metadata(&path).unwrap().ino();
    update_at(&path, |_| Ok(())).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().ino(), antes, "o arquivo foi reescrito sem mudança");
    update_at(&path, |tasks| {
        tasks[0].name = "Outro nome".into();
        Ok(())
    })
    .unwrap();
    assert_ne!(std::fs::metadata(&path).unwrap().ino(), antes, "uma mudança de verdade precisa gravar");
}

#[test]
fn arquivo_invalido_vira_copia_e_as_tarefas_seguem_a_funcionar() {
    let dir = dir();
    let path = dir.join("scheduled-tasks.json");
    std::fs::write(&path, "{ isto não é json").unwrap();
    update_at(&path, |tasks| {
        assert!(tasks.is_empty());
        tasks.push(task(Schedule::Every { secs: 300 }, None));
        Ok(())
    })
    .expect("um arquivo inválido não pode bloquear a criação");
    let copias: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("scheduled-tasks.invalido-"))
        .collect();
    assert_eq!(copias.len(), 1);
    assert_eq!(std::fs::read_to_string(copias[0].path()).unwrap(), "{ isto não é json", "a cópia guarda o original intacto");
    assert_eq!(read_file_at(&path).unwrap().0.tasks.len(), 1);
}

#[test]
fn versao_desconhecida_tambem_e_guardada_e_nao_bloqueia() {
    let dir = dir();
    let path = dir.join("scheduled-tasks.json");
    std::fs::write(&path, r#"{"version":99,"tasks":[]}"#).unwrap();
    let (file, _) = read_file_at(&path).unwrap();
    assert!(file.tasks.is_empty());
    assert!(std::fs::read_dir(&dir).unwrap().filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().contains("invalido")));
}

#[test]
fn reivindicar_o_horario_avanca_o_next_run_e_impede_um_segundo_dispatch() {
    let mut t = task(Schedule::Every { secs: 300 }, Some(1_000));
    claim_due(&mut t, 1_000, at(1_010)).unwrap();
    assert_eq!(t.next_run, Some(1_310), "o próximo horário já vale antes do dispatch");
    assert!(claim_due(&mut t, 1_000, at(1_011)).is_err(), "o mesmo horário não é reivindicado duas vezes");
    assert!(t.enabled);
}

#[test]
fn reivindicar_uma_tarefa_unica_a_desliga() {
    let mut t = task(Schedule::Once { at: 1_000 }, Some(1_000));
    claim_due(&mut t, 1_000, at(1_010)).unwrap();
    assert!(!t.enabled);
    assert_eq!(t.next_run, None);
}

#[test]
fn nao_reivindica_tarefa_desligada_nem_horario_que_mudou() {
    let mut t = task(Schedule::Every { secs: 300 }, Some(1_000));
    assert!(claim_due(&mut t, 900, at(1_010)).is_err());
    t.enabled = false;
    assert!(claim_due(&mut t, 1_000, at(1_010)).is_err());
    assert_eq!(t.next_run, Some(1_000), "recusar não mexe na tarefa");
}
