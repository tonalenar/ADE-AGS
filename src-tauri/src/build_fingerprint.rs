//! Inputs that may rerun `build.rs`.
//!
//! Git metadata is absent on purpose. A commit in any linked worktree updates the
//! shared `refs` directory. Watching that directory, `HEAD`, or the common `.git`
//! rebuilds `ade-ags` for every agent that shares `CARGO_TARGET_DIR`.
//! `ADE_BUILD_HASH` is still captured when these paths rebuild the crate. It is the
//! HEAD of that rebuild, not a live subscription to every commit.

#[cfg_attr(not(test), allow(dead_code))]
pub const RERUN_PATHS: &[&str] = &["src", "build.rs"];

#[cfg(test)]
pub fn watches_shared_git_refs(paths: &[&str]) -> bool {
    paths.iter().any(|path| {
        let path = path.replace('\\', "/");
        path == "../.git"
            || path.ends_with("/.git")
            || path.contains("/refs")
            || path.ends_with("/HEAD")
            || path == "HEAD"
            || path.contains("git-path")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_target_does_not_rerun_on_git_refs() {
        assert!(!watches_shared_git_refs(RERUN_PATHS));
        assert!(RERUN_PATHS.contains(&"src"));
        assert!(RERUN_PATHS.contains(&"build.rs"));
        let script = include_str!("../build.rs");
        assert!(script.contains("build_fingerprint::RERUN_PATHS"));
        assert!(!script.contains("../.git"));
        assert!(!script.contains("git-path"));
        assert!(!script.contains("rerun-if-changed=refs"));
    }
}
