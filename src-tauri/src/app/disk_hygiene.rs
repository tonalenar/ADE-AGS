//! O que a app pode limpar sozinha, sem perder trabalho de ninguém.
//!
//! No disco real havia ~33 GB recuperáveis: 18,5 GB de `debug/incremental` no target dos agentes
//! (uma cópia de ~1,1 GB por caminho de worktree, que não se reaproveitam entre worktrees), `target/`
//! reais de 6 a 7 GB dentro de worktrees de missões já encerradas, backups `data.vNN-*.backup` que
//! nunca eram rotacionados e um banco com metade das páginas livres. Tudo aqui é cache ou cópia:
//! o cargo recria o incremental e o `target/`, e os backups mais novos ficam.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::Connection;

/// Incremental sem uso há mais que isto sai. Cada worktree tem a sua cópia (o caminho entra no hash
/// do crate) e uma worktree parada há 3 dias é, na prática, de missão encerrada; se voltar, o cargo
/// recompila uma vez.
pub const INCREMENTAL_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// Backups do próprio app (`data.vNN-*.backup`) que ficam.
pub const BACKUPS_KEPT: usize = 2;
/// Fração de páginas livres a partir da qual vale um VACUUM.
pub const VACUUM_FREE_SHARE: f64 = 0.3;
/// Banco menor que isto não compensa.
pub const VACUUM_MIN_BYTES: i64 = 8 * 1024 * 1024;
const LAST_VACUUM_KEY: &str = "db.last_vacuum";
const VACUUM_EVERY_SECS: i64 = 24 * 60 * 60;

/// Uma pasta de verdade (não link, não junção, não montagem). Só essas se apagam.
fn real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) && !crate::skills::is_mount(path)
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Apaga, em `<target>/{debug,release}/incremental/`, as pastas por crate sem uso há mais de
/// `max_age`. Devolve quantas saíram.
pub fn prune_incremental(target: &Path, max_age: Duration, now: SystemTime) -> usize {
    let mut removed = 0;
    for profile in ["debug", "release"] {
        let dir = target.join(profile).join("incremental");
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let old = modified(&path).and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age > max_age);
            if old && real_dir(&path) && std::fs::remove_dir_all(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Os `target/` reais dentro de worktrees de missões encerradas (o agente rodou cargo sem o target
/// compartilhado). Só dentro de `worktrees_base`, nunca seguindo link. Devolve quantos saíram.
pub fn prune_finished_targets(conn: &Connection, worktrees_base: &Path) -> usize {
    let Ok(mut stmt) = conn.prepare(
        "SELECT w.root FROM mission_team_workspaces w JOIN missions m ON m.id = w.mission_id WHERE m.status IN (SELECT value FROM json_each(?1))",
    ) else {
        return 0;
    };
    let finished = serde_json::to_string(crate::missions::cleanup::FINISHED).unwrap_or_else(|_| "[]".into());
    let Ok(rows) = stmt.query_map([finished], |r| r.get::<_, String>(0)) else { return 0 };
    let base = std::fs::canonicalize(worktrees_base).unwrap_or_else(|_| worktrees_base.to_path_buf());
    let mut removed = 0;
    for root in rows.flatten() {
        let root = PathBuf::from(root);
        let inside = std::fs::canonicalize(&root).is_ok_and(|r| r.starts_with(&base));
        if !inside {
            continue;
        }
        for target in [root.join("target"), root.join("src-tauri").join("target")] {
            if real_dir(&target) && std::fs::remove_dir_all(&target).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Os backups do app (`data.v<versão>-<id>.backup`) além dos `keep` mais novos. Pura sobre a lista
/// (nome, data): devolve os que saem.
pub fn backups_to_remove(mut backups: Vec<(PathBuf, SystemTime)>, keep: usize) -> Vec<PathBuf> {
    backups.sort_by(|a, b| b.1.cmp(&a.1));
    backups.into_iter().skip(keep).map(|(p, _)| p).collect()
}

pub fn rotate_backups(data_dir: &Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(data_dir) else { return 0 };
    let backups: Vec<(PathBuf, SystemTime)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name.starts_with("data.v") && name.ends_with(".backup") && p.is_file()
        })
        .filter_map(|p| modified(&p).map(|m| (p, m)))
        .collect();
    backups_to_remove(backups, keep).into_iter().filter(|p| std::fs::remove_file(p).is_ok()).count()
}

/// Vale um VACUUM? Pura.
pub fn should_vacuum(page_count: i64, freelist: i64, page_size: i64, last_vacuum: Option<i64>, now: i64) -> bool {
    page_count > 0
        && page_count * page_size >= VACUUM_MIN_BYTES
        && (freelist as f64) / (page_count as f64) >= VACUUM_FREE_SHARE
        && last_vacuum.is_none_or(|t| now - t >= VACUUM_EVERY_SECS)
}

/// VACUUM numa conexão própria, se o banco estiver com muitas páginas livres (no real, 51%: a
/// coluna `tabs.scrollback`, regravada a cada 20 s, deixa buracos). No máximo um por dia.
pub fn maybe_vacuum(conn: &Connection, now: i64) -> bool {
    let q = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
    let last: Option<i64> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [LAST_VACUUM_KEY], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| v.parse().ok());
    if !should_vacuum(q("PRAGMA page_count"), q("PRAGMA freelist_count"), q("PRAGMA page_size"), last, now) {
        return false;
    }
    let ok = conn.execute_batch("VACUUM; PRAGMA optimize;").is_ok();
    let _ = conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![LAST_VACUUM_KEY, now.to_string()],
    );
    ok
}

/// Tudo de uma vez, no fim da manutenção de arranque. Uma falha em uma parte não impede as outras.
pub fn run() {
    let now = SystemTime::now();
    let incremental = prune_incremental(&crate::floors::agents_cargo_target_dir(), INCREMENTAL_MAX_AGE, now);
    let mut targets = 0;
    let mut vacuumed = false;
    if let Ok(conn) = crate::database::open_side_connection() {
        if let Some(home) = dirs::home_dir() {
            targets = prune_finished_targets(&conn, &home.join(".ags").join("worktrees"));
        }
        vacuumed = maybe_vacuum(&conn, crate::util::now_ts());
    }
    let backups = crate::util::datadir::ags_home().map(|dir| rotate_backups(&dir, BACKUPS_KEPT)).unwrap_or(0);
    if incremental + targets + backups > 0 || vacuumed {
        eprintln!("[disco] incremental: {incremental} · target de missão encerrada: {targets} · backups: {backups} · vacuum: {vacuumed}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incremental_velho_sai_e_o_recente_fica() {
        let target = std::env::temp_dir().join(format!("ags-incr-{}", uuid::Uuid::new_v4().simple()));
        let old = target.join("debug/incremental/ade_ags_lib-aaa");
        let fresh = target.join("debug/incremental/ade_ags_lib-bbb");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        // Agora: as duas acabaram de ser criadas e ficam. Daqui a 8 dias: as duas passaram do limite e saem.
        let later = SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60);
        assert_eq!(prune_incremental(&target, INCREMENTAL_MAX_AGE, SystemTime::now()), 0);
        assert_eq!(prune_incremental(&target, INCREMENTAL_MAX_AGE, later), 2);
        assert!(!old.exists() && !fresh.exists());
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn ficam_os_dois_backups_mais_novos() {
        let t = |s: u64| SystemTime::UNIX_EPOCH + Duration::from_secs(s);
        let list = vec![(PathBuf::from("a"), t(1)), (PathBuf::from("c"), t(3)), (PathBuf::from("b"), t(2)), (PathBuf::from("d"), t(4))];
        assert_eq!(backups_to_remove(list, 2), [PathBuf::from("b"), PathBuf::from("a")]);
        assert!(backups_to_remove(vec![], 2).is_empty());
    }

    #[test]
    fn vacuum_so_com_banco_grande_muito_livre_e_uma_vez_por_dia() {
        let mb = 1024 * 1024;
        assert!(should_vacuum(6591, 3352, 4096, None, 0), "o caso real: 27 MB, 51% livre");
        assert!(!should_vacuum(6591, 1000, 4096, None, 0), "15% livre");
        assert!(!should_vacuum(100, 90, 4096, None, 0), "banco pequeno");
        assert!(!should_vacuum(8 * mb / 4096, 8 * mb / 4096 / 2, 4096, Some(1_000), 1_000 + 3_600), "já rodou há 1 h");
        assert!(should_vacuum(8 * mb / 4096, 8 * mb / 4096 / 2, 4096, Some(0), VACUUM_EVERY_SECS));
    }

    #[test]
    fn target_de_missao_encerrada_sai_so_dentro_dos_worktrees() {
        let base = std::env::temp_dir().join(format!("ags-wt-base-{}", uuid::Uuid::new_v4().simple()));
        let inside = base.join("abc");
        let outside = std::env::temp_dir().join(format!("ags-wt-out-{}", uuid::Uuid::new_v4().simple()));
        for root in [&inside, &outside] {
            std::fs::create_dir_all(root.join("src-tauri/target/debug")).unwrap();
        }
        let conn = crate::database::test_db();
        conn.execute_batch("INSERT INTO workspaces(id,name,created_at,last_active) VALUES('w','W',0,0);").unwrap();
        for (id, status, root) in [("m1", "done_without_delivery", &inside), ("m2", "done", &outside)] {
            conn.execute("INSERT INTO missions(id,workspace_id,title,objective,cwd,status,created_at,updated_at) VALUES(?1,'w','t','o','/x',?2,0,0)", rusqlite::params![id, status]).unwrap();
            conn.execute("INSERT INTO mission_team_workspaces(mission_id,name,cwd,root,branch) VALUES(?1,'B',?2,?2,?1)", rusqlite::params![id, root.to_string_lossy()]).unwrap();
        }
        assert_eq!(prune_finished_targets(&conn, &base), 1);
        assert!(!inside.join("src-tauri/target").exists());
        assert!(outside.join("src-tauri/target").exists(), "fora de ~/.ags/worktrees nunca");
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
