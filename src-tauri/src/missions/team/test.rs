use super::*;
use std::process::Command;

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(cwd).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn names_must_be_unique_and_bounded_before_creating_worktrees() {
    assert!(validate_members(&[]).is_err());
    assert!(validate_members(&["A".into(), "A".into()]).is_err());
    assert!(validate_members(&[" ".into()]).is_err());
    assert!(validate_members(&vec!["A".into(); 33]).is_err());
    assert!(validate_members(&["Orquestrador".into(), "Backend".into()]).is_ok());
}

#[test]
fn each_member_gets_origin_master_workspace_retry_preserves_work_and_junction() {
    let scratch = std::env::temp_dir().join(format!("ags-team-{}", uuid::Uuid::new_v4()));
    let repo = scratch.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init"]);
    std::fs::write(repo.join("source.txt"), "baseline").unwrap();
    std::fs::write(repo.join(".gitignore"), "node_modules/\nsrc-tauri/target/\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]);
    git(&repo, &["update-ref", "refs/remotes/origin/master", "HEAD"]);
    std::fs::create_dir(repo.join("node_modules")).unwrap();
    std::fs::write(repo.join("source.txt"), "dirty clone").unwrap();
    let conn = crate::database::test_db();
    conn.execute("INSERT INTO workspaces (id,name,created_at,last_active) VALUES ('w','W',0,0)", []).unwrap();
    conn.execute("INSERT INTO missions (id,workspace_id,title,objective,cwd,created_at,updated_at) VALUES ('m','w','T','O',?1,1,1)", [repo.to_string_lossy().as_ref()]).unwrap();
    let mission = super::super::store::get(&conn, "m").unwrap().unwrap();
    let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
    let base = scratch.join("worktrees");
    let a = prepare_one(&db, &mission, "Orquestrador", &base).unwrap();
    let b = prepare_one(&db, &mission, "Backend", &base).unwrap();
    assert_ne!(a.root, b.root); assert_ne!(a.branch, b.branch);
    assert_ne!(a.cargo_target_dir, b.cargo_target_dir);
    assert_eq!(std::fs::read_to_string(Path::new(&b.root).join("source.txt")).unwrap(), "baseline");
    assert_eq!(std::fs::canonicalize(Path::new(&b.root).join("node_modules")).unwrap(), std::fs::canonicalize(repo.join("node_modules")).unwrap());
    std::fs::write(Path::new(&b.root).join("source.txt"), "member work").unwrap();
    let retry = prepare_one(&db, &mission, "Backend", &base).unwrap();
    assert_eq!(retry.root, b.root); assert_eq!(retry.branch, b.branch);
    assert_eq!(std::fs::read_to_string(Path::new(&retry.root).join("source.txt")).unwrap(), "member work");
    assert!(retry.environment.contains("isolado por worktree"));
    assert!(retry.prelaunch.contains(&retry.cargo_target_dir));
    // Test-only cleanup, unlink junctions explicitly before removing owned fixture roots.
    for workspace in [&a, &b] {
        let link = Path::new(&workspace.root).join("node_modules");
        #[cfg(windows)] std::fs::remove_dir(&link).unwrap();
        #[cfg(not(windows))] std::fs::remove_file(&link).unwrap();
        git(&repo, &["worktree", "remove", "--force", &workspace.root]);
    }
    std::fs::remove_dir_all(&scratch).unwrap();
}
