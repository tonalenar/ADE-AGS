use super::*;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Tmp(PathBuf);
impl Tmp {
    fn new(name: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("cc-cp-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=cc-test", "-c", "user.email=cc@test"])
        .args(args)
        .output()
        .expect("git instalado");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> Tmp {
    let t = Tmp::new("repo");
    sh(&t.0, &["init", "-q", "-b", "main"]);
    std::fs::write(t.0.join(".gitignore"), "ignorado.log\n").unwrap();
    std::fs::write(t.0.join("a.txt"), "uno\n").unwrap();
    std::fs::write(t.0.join("b.txt"), "dos\n").unwrap();
    sh(&t.0, &["add", "."]);
    sh(&t.0, &["commit", "-q", "-m", "inicio"]);
    t
}

fn read(dir: &Path, f: &str) -> Option<String> {
    // Git en Windows puede devolver CRLF según `core.autocrlf`: el contenido es lo que importa.
    std::fs::read_to_string(dir.join(f)).ok().map(|c| c.replace("\r\n", "\n"))
}

#[test]
fn la_foto_no_toca_el_indice_ni_la_rama_ni_el_arbol() {
    let r = repo();
    std::fs::write(r.0.join("a.txt"), "uno cambiado\n").unwrap();
    std::fs::write(r.0.join("nuevo.txt"), "nuevo\n").unwrap();
    let status_antes = sh(&r.0, &["status", "--porcelain"]);
    let head_antes = sh(&r.0, &["rev-parse", "HEAD"]);

    let snap = snapshot(&r.0, "t1", "prueba").unwrap();

    assert_eq!(sh(&r.0, &["status", "--porcelain"]), status_antes, "el estado no cambió");
    assert_eq!(sh(&r.0, &["rev-parse", "HEAD"]), head_antes);
    assert_eq!(snap.head, head_antes);
    // La foto lleva lo modificado y lo nuevo, con el HEAD como padre; y cuelga de una ref.
    assert_eq!(sh(&r.0, &["show", &format!("{}:a.txt", snap.commit)]), "uno cambiado");
    assert_eq!(sh(&r.0, &["show", &format!("{}:nuevo.txt", snap.commit)]), "nuevo");
    assert_eq!(sh(&r.0, &["rev-parse", &format!("{}^", snap.commit)]), head_antes);
    assert_eq!(sh(&r.0, &["rev-parse", "refs/controlcode/checkpoints/t1"]), snap.commit);
    // Sin restos del índice temporal.
    let leftovers: Vec<_> = std::fs::read_dir(r.0.join(".git"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("cc-checkpoint"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn restaurar_devuelve_los_archivos_el_head_y_borra_lo_nuevo_sin_tocar_lo_ignorado() {
    let r = repo();
    // Estado de la foto: a.txt editado sin commitear, c.txt nuevo.
    std::fs::write(r.0.join("a.txt"), "uno en la foto\n").unwrap();
    std::fs::write(r.0.join("c.txt"), "c de la foto\n").unwrap();
    let head = sh(&r.0, &["rev-parse", "HEAD"]);
    let snap = snapshot(&r.0, "t1", "antes").unwrap();

    // Después: el agente edita, borra, crea, commitea e ignora cosas.
    std::fs::write(r.0.join("a.txt"), "uno roto\n").unwrap();
    std::fs::remove_file(r.0.join("b.txt")).unwrap();
    std::fs::remove_file(r.0.join("c.txt")).unwrap();
    std::fs::write(r.0.join("d.txt"), "d nuevo\n").unwrap();
    std::fs::create_dir_all(r.0.join("sub")).unwrap();
    std::fs::write(r.0.join("sub/e.txt"), "e\n").unwrap();
    sh(&r.0, &["add", "-A"]);
    sh(&r.0, &["commit", "-q", "-m", "el agente comiteó"]);
    std::fs::write(r.0.join("ignorado.log"), "no se toca\n").unwrap();
    assert_ne!(sh(&r.0, &["rev-parse", "HEAD"]), head);

    restore(&r.0, &snap.commit, &snap.head).unwrap();

    assert_eq!(sh(&r.0, &["rev-parse", "HEAD"]), head, "HEAD de vuelta");
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("uno en la foto\n"));
    assert_eq!(read(&r.0, "b.txt").as_deref(), Some("dos\n"), "lo borrado vuelve");
    assert_eq!(read(&r.0, "c.txt").as_deref(), Some("c de la foto\n"));
    assert!(read(&r.0, "d.txt").is_none(), "lo que nació después se va");
    assert!(!r.0.join("sub").exists());
    assert_eq!(read(&r.0, "ignorado.log").as_deref(), Some("no se toca\n"), "lo ignorado no se toca");
    // Los cambios quedan sin commitear y sin preparar, como estaban.
    let status = sh(&r.0, &["status", "--porcelain"]);
    assert!(status.contains("M a.txt") && status.contains("?? c.txt"), "{status}");
}

#[test]
fn restaurar_una_foto_que_ya_no_esta_falla_sin_tocar_nada() {
    let r = repo();
    std::fs::write(r.0.join("a.txt"), "cambiado\n").unwrap();
    let head = sh(&r.0, &["rev-parse", "HEAD"]);
    let err = restore(&r.0, "0123456789012345678901234567890123456789", &head).unwrap_err();
    assert!(err.contains("ya no está"), "{err}");
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("cambiado\n"), "no se perdió nada");
}

#[test]
fn sin_commits_no_hay_foto_y_lo_dice() {
    let t = Tmp::new("vacio");
    sh(&t.0, &["init", "-q", "-b", "main"]);
    assert!(snapshot(&t.0, "x", "l").unwrap_err().contains("ningún commit"));
    let fuera = Tmp::new("no-repo");
    assert!(snapshot(&fuera.0, "x", "l").is_err());
}

// ── El plan (puro) ──────────────────────────────────────────────

fn item(id: &str, status: &str, deps: &[&str], dir: &str, before: Option<(&str, i64)>) -> Item {
    Item {
        id: id.into(),
        status: status.into(),
        depends_on: deps.iter().map(|d| d.to_string()).collect(),
        dir: Some(dir.into()),
        before: before.map(|(c, t)| (c.to_string(), t)),
        lead: false,
    }
}

#[test]
fn volver_atras_arrastra_a_las_que_dependen_y_deja_las_independientes() {
    let items = vec![
        item("api", "done", &[], "/wt/api", Some(("cp-api", 10))),
        item("tests", "done", &["api"], "/wt/tests", Some(("cp-tests", 20))),
        item("docs", "done", &[], "/wt/docs", Some(("cp-docs", 15))),
    ];
    let p = plan(&items, "api").unwrap();
    assert_eq!(p.tasks, vec!["api", "tests"]);
    assert_eq!(p.restores.len(), 2);
    assert!(p.restores.contains(&("/wt/api".into(), "cp-api".into())));
    assert!(p.restores.contains(&("/wt/tests".into(), "cp-tests".into())));
    assert!(p.without_checkpoint.is_empty());
}

#[test]
fn las_que_corrieron_despues_en_la_misma_carpeta_se_rehacen_y_se_restaura_la_foto_mas_vieja() {
    let items = vec![
        item("uno", "done", &[], "/proy", Some(("cp-uno", 10))),
        item("dos", "done", &[], "/proy", Some(("cp-dos", 20))),
        item("tres", "failed", &[], "/proy", Some(("cp-tres", 30))),
        item("antes", "done", &[], "/proy", Some(("cp-antes", 5))),
    ];
    let p = plan(&items, "dos").unwrap();
    assert_eq!(p.tasks, vec!["dos", "tres"], "la anterior ('antes', 'uno') no se toca");
    assert_eq!(p.restores, vec![("/proy".to_string(), "cp-dos".to_string())]);
    // Y la transitividad: lo que depende de una arrastrada también.
    let mut items = items;
    items.push(item("cola", "done", &["tres"], "/otra", Some(("cp-cola", 40))));
    let p = plan(&items, "dos").unwrap();
    assert_eq!(p.tasks, vec!["dos", "tres", "cola"]);
    assert_eq!(p.restores.len(), 2);
}

#[test]
fn con_dos_afectadas_en_una_carpeta_gana_la_foto_mas_vieja() {
    let items = vec![
        item("a", "done", &[], "/proy", Some(("cp-a", 10))),
        item("b", "done", &["a"], "/proy", Some(("cp-b", 20))),
    ];
    let p = plan(&items, "b").unwrap();
    assert_eq!(p.tasks, vec!["b"]);
    let p = plan(&items, "a").unwrap();
    assert_eq!(p.tasks, vec!["a", "b"]);
    assert_eq!(p.restores, vec![("/proy".to_string(), "cp-a".to_string())], "la de a, que es la más vieja");
}

#[test]
fn sin_foto_hay_error_y_una_afectada_sin_foto_se_avisa() {
    let items = vec![
        item("a", "done", &[], "/wt/a", None),
        item("b", "done", &["a"], "/wt/b", Some(("cp-b", 20))),
    ];
    assert!(plan(&items, "a").unwrap_err().contains("não tem foto"));

    let items = vec![
        item("a", "done", &[], "/wt/a", Some(("cp-a", 10))),
        Item { before: None, dir: None, ..item("b", "done", &["a"], "", None) },
    ];
    let p = plan(&items, "a").unwrap();
    assert_eq!(p.tasks, vec!["a", "b"]);
    assert_eq!(p.without_checkpoint, vec!["b"]);
}

#[test]
fn con_algo_corriendo_o_con_un_lider_no_se_puede() {
    let items = vec![
        item("a", "done", &[], "/wt/a", Some(("cp-a", 10))),
        item("b", "running", &[], "/wt/b", Some(("cp-b", 20))),
    ];
    assert!(plan(&items, "a").unwrap_err().contains("está rodando"));
    let lider = Item { lead: true, ..item("l", "done", &[], "/p", Some(("cp-l", 1))) };
    assert!(plan(&[lider.clone()], "l").unwrap_err().contains("líder"));
    // Y el líder nunca entra en lo que se rehace.
    let items = vec![lider, item("a", "done", &[], "/p", Some(("cp-a", 5)))];
    assert_eq!(plan(&items, "a").unwrap().tasks, vec!["a"]);
    assert!(plan(&items, "nada").unwrap_err().contains("não existe"));
}

// ── Con la base y un repo de verdad ─────────────────────────────

fn db_con_run(cwd: &str) -> (crate::database::DbConnection, String) {
    let conn = crate::database::test_db();
    conn.execute("INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1','W',0,0)", []).unwrap();
    let run = crate::runs::store::create_run(&conn, "w1", "objetivo", cwd).unwrap();
    (Arc::new(Mutex::new(conn)), run.id)
}

fn tarea(db: &crate::database::DbConnection, run: &str, title: &str, cwd: &str, deps: &[&str]) -> String {
    let conn = db.lock().unwrap();
    let t = crate::runs::store::create_task(
        &conn,
        &crate::runs::store::NewTask {
            run_id: run,
            title,
            prompt: "x",
            agent_id: "claude-code",
            cwd,
            queued: true,
            ..Default::default()
        },
    )
    .unwrap();
    for d in deps {
        conn.execute("INSERT INTO task_deps (task_id, depends_on) VALUES (?1, ?2)", rusqlite::params![t.id, d]).unwrap();
    }
    t.id
}

fn plan_de(db: &crate::database::DbConnection, run: &str, task: &str) -> Result<Plan, String> {
    let conn = db.lock().unwrap();
    let tasks = crate::runs::store::tasks_of_run(&conn, run).unwrap();
    let items = items_of(&conn, run, &tasks).unwrap();
    plan(&items, task)
}

#[test]
fn rollback_de_punta_a_punta_restaura_la_carpeta_y_deja_las_tareas_en_cola() {
    let r = repo();
    let cwd = r.0.to_string_lossy().to_string();
    let (db, run) = db_con_run(&cwd);
    let a = tarea(&db, &run, "a", &cwd, &[]);
    let b = tarea(&db, &run, "b", &cwd, &[&a]);

    // La tarea a: foto antes, trabaja, foto después.
    take(&db, &run, Some(&a), &r.0, kind::BEFORE, "antes de a").unwrap();
    std::fs::write(r.0.join("a.txt"), "a trabajó\n").unwrap();
    std::fs::write(r.0.join("de_a.txt"), "de a\n").unwrap();
    take(&db, &run, Some(&a), &r.0, kind::AFTER, "después de a").unwrap();
    // La tarea b arranca después y rompe cosas.
    take(&db, &run, Some(&b), &r.0, kind::BEFORE, "antes de b").unwrap();
    std::fs::write(r.0.join("b.txt"), "b rompió\n").unwrap();
    {
        let conn = db.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET status = 'done', result = 'ok', session_id = 's', ended_at = 5 WHERE id IN (?1, ?2)",
            rusqlite::params![a, b],
        )
        .unwrap();
    }

    let p = plan_de(&db, &run, &a).unwrap();
    assert_eq!(p.tasks, vec![a.clone(), b.clone()]);

    let safeties = rollback(&db, &run, &p).unwrap();

    // La carpeta volvió a antes de a: sin el trabajo de a ni el de b.
    assert_eq!(read(&r.0, "a.txt").as_deref(), Some("uno\n"));
    assert_eq!(read(&r.0, "b.txt").as_deref(), Some("dos\n"));
    assert!(read(&r.0, "de_a.txt").is_none());
    // Las dos en cola, limpias; el run vuelve a "running".
    let conn = db.lock().unwrap();
    for id in [&a, &b] {
        let t = crate::runs::store::task_by_id(&conn, id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.result, t.session_id, t.ended_at), ("pending", None, None, None));
    }
    assert_eq!(crate::runs::store::run_by_id(&conn, &run).unwrap().unwrap().status, "running");
    // Y quedó la foto de seguridad para deshacer el rollback: tiene el trabajo que se perdió.
    assert_eq!(safeties.len(), 1);
    assert_eq!(safeties[0].kind, kind::SAFETY);
    assert_eq!(sh(&r.0, &["show", &format!("{}:b.txt", safeties[0].commit_sha)]), "b rompió");
}

#[test]
fn si_la_carpeta_ya_no_existe_no_se_toca_nada() {
    let r = repo();
    let cwd = r.0.to_string_lossy().to_string();
    let (db, run) = db_con_run(&cwd);
    let a = tarea(&db, &run, "a", &cwd, &[]);
    take(&db, &run, Some(&a), &r.0, kind::BEFORE, "antes").unwrap();
    {
        let conn = db.lock().unwrap();
        conn.execute("UPDATE tasks SET status = 'done' WHERE id = ?1", [&a]).unwrap();
    }
    let mut p = plan_de(&db, &run, &a).unwrap();
    p.restores[0].0 = r.0.join("no-existe").to_string_lossy().to_string();
    let err = rollback(&db, &run, &p).unwrap_err();
    assert!(err.contains("já não existe"), "{err}");
    let conn = db.lock().unwrap();
    assert_eq!(crate::runs::store::task_by_id(&conn, &a).unwrap().unwrap().status, "done", "la tarea no se tocó");
}

#[test]
fn las_fotos_viejas_de_un_run_se_sueltan_pero_la_lista_sale_en_orden() {
    let (db, run) = db_con_run("/tmp/p");
    let conn = db.lock().unwrap();
    for i in 0..(MAX_PER_RUN + 5) {
        insert(
            &conn,
            &Checkpoint {
                id: format!("c{i:04}"),
                run_id: run.clone(),
                task_id: None,
                kind: kind::MANUAL.into(),
                dir: "/tmp/p".into(),
                commit_sha: "x".into(),
                head_sha: None,
                label: String::new(),
                created_at: i as i64,
            },
        )
        .unwrap();
    }
    let all = list(&conn, &run).unwrap();
    assert_eq!(all.len(), MAX_PER_RUN);
    assert_eq!(all[0].id, "c0005", "se soltaron las 5 más viejas");
    assert_eq!(get(&conn, "c0000").unwrap(), None);
    assert!(get(&conn, "c0010").unwrap().is_some());
}
