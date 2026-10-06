use super::*;

fn p(files: &[&str]) -> Plan {
    plan(&files.iter().map(|f| f.to_string()).collect::<Vec<_>>())
}

fn suites(plan: &Plan) -> Vec<&'static str> {
    plan.steps.iter().map(|s| s.suite).collect()
}

#[test]
fn frontend_only_runs_related_tsc_and_babel() {
    let plan = p(&["src/features/missions/timings.ts", "src\\i18n\\locales\\en.json"]);
    assert_eq!(suites(&plan), ["babel", "tsc", "frontend"]);
    assert!(!plan.full);
    let vitest = &plan.steps[2];
    assert_eq!(&vitest.args[1..3], ["related", "--run"]);
    assert!(vitest.args.contains(&"src/i18n/locales/en.json".to_string()));
}

#[test]
fn rust_module_is_deduced_from_path() {
    let plan = p(&["src-tauri/src/floors.rs", "src-tauri/src/missions/efficiency/test.rs", "src-tauri/src/missions/store.rs"]);
    assert_eq!(suites(&plan), ["rust"]);
    let step = &plan.steps[0];
    assert_eq!(step.cwd, Some("src-tauri"));
    assert_eq!(step.args, ["test", "--lib", "--", "floors::", "missions::"]);
}

#[test]
fn mixed_change_runs_both_sides() {
    let plan = p(&["src/App.tsx", "src-tauri/src/database/schema.rs"]);
    assert_eq!(suites(&plan), ["babel", "tsc", "frontend", "rust"]);
}

#[test]
fn docs_only_has_nothing_to_run() {
    let plan = p(&["docs/ade-ags/TEST_SPEED.md", "README.md", "skills/ags-orchestrator/SKILL.md"]);
    assert!(plan.is_empty());
    assert!(!plan.full);
    assert_eq!(plan.ignored.len(), 3);
    assert!(plan.render_dry_run().contains("Nada a testar"));
}

#[test]
fn unknown_file_falls_back_to_full_and_says_so() {
    let plan = p(&["src/App.tsx", "weird/new-tool.toml"]);
    assert!(plan.full);
    assert_eq!(plan.unmapped, ["weird/new-tool.toml"]);
    assert_eq!(suites(&plan), ["babel", "tsc", "frontend", "rust"]);
    assert_eq!(plan.steps[2].args, [VITEST, "run"]);
    assert_eq!(plan.steps[3].args, ["test", "--lib", "--bin", "ags"]);
    assert!(plan.render_dry_run().contains("? weird/new-tool.toml"));
}

#[test]
fn global_config_runs_whole_side() {
    assert_eq!(p(&["package.json"]).steps[2].args, [VITEST, "run"]);
    let rust = p(&["src-tauri/Cargo.lock"]);
    assert_eq!(rust.steps[0].args, ["test", "--lib", "--bin", "ags"]);
    assert!(!rust.full);
    assert_eq!(suites(&p(&["src-tauri/src/lib.rs"])), ["rust"]);
}

#[test]
fn cli_changes_run_the_bin_tests() {
    let plan = p(&["src-tauri/src/bin/cli.rs", "src-tauri/src/cli_test.rs"]);
    assert_eq!(plan.steps.len(), 1);
    assert_eq!(plan.steps[0].args, ["test", "--bin", "ags"]);
}

#[test]
fn many_frontend_files_use_changed_flag_and_input_is_deduped() {
    let many: Vec<String> = (0..200).map(|i| format!("src/f{i}.ts")).collect();
    let plan = plan(&many);
    assert_eq!(plan.steps[2].args, [VITEST, "run", "--changed", "origin/master"]);
    let dup = p(&["./src/a.ts", "src/a.ts"]);
    assert_eq!(dup.steps[2].args.len(), 4);
}

#[test]
fn empty_input_is_an_empty_plan() {
    assert!(p(&[]).is_empty());
}

#[test]
fn dry_run_shows_cwd_and_commands() {
    let text = p(&["src-tauri/src/floors.rs"]).render_dry_run();
    assert!(text.contains("[rust] (src-tauri) cargo test --lib -- floors::"));
}

#[test]
fn database_changes_demand_full_rust_with_reason() {
    let plan = p(&["src-tauri/src/database/schema.rs"]);
    assert!(plan.full);
    assert_eq!(suites(&plan), ["rust"]);
    assert_eq!(plan.steps[0].args, ["test", "--lib", "--bin", "ags"]);
    assert!(plan.risk[0].contains("banco/schema"));
    assert!(plan.render_dry_run().contains("Mudança de risco"));
    assert!(plan.unmapped.is_empty());
}

#[test]
fn windows_com_paths_demand_full_rust() {
    let plan = p(&["src-tauri/src/notifier/identity.rs", "src/App.tsx"]);
    assert!(plan.full);
    assert_eq!(suites(&plan), ["babel", "tsc", "frontend", "rust"]);
    assert_eq!(plan.steps[2].args[1], "related");
    assert!(plan.risk[0].contains("unsafe/COM"));
    assert!(p(&["src-tauri/src/window/mod.rs"]).full);
}

#[test]
fn schema_files_demand_full_rust() {
    assert!(p(&["src-tauri/migrations/001.sql"]).full);
}

#[test]
fn ordinary_rust_module_is_not_risky() {
    let plan = p(&["src-tauri/src/floors.rs"]);
    assert!(!plan.full && plan.risk.is_empty());
}

#[test]
fn unsafe_added_in_diff_marks_the_file_risky() {
    let diff = "diff --git a/src-tauri/src/floors.rs b/src-tauri/src/floors.rs\n--- a/src-tauri/src/floors.rs\n+++ b/src-tauri/src/floors.rs\n@@ -1 +1,2 @@\n+    unsafe { call() }\n+// unsafe em comentário\n+++ b/src-tauri/src/missions/a.rs\n+let unsafely = 1;\n";
    let files = files_adding_unsafe(diff);
    assert_eq!(files, ["src-tauri/src/floors.rs"]);
    let plan = plan_with_unsafe(&["src-tauri/src/floors.rs".to_string()], &files);
    assert!(plan.full);
    assert!(plan.risk[0].contains("adiciona unsafe"));
    assert!(files_adding_unsafe("").is_empty());
}
