fn main() {
    build_identity();
    tauri_build::build();

    // `cargo:rustc-link-arg-tests` no llega al harness de los unit tests de la lib
    // (Cargo solo se lo pasa a `tests/*.rs`). El manifiesto va en una .lib que la
    // lib referencia con `#[link]` bajo `cfg(test)`, así que el binario de la app
    // no lo hereda: tauri-build ya le incrusta el suyo.
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("windows") {
        embed_test_manifest();
    }
}

#[path = "src/build_fingerprint.rs"]
mod build_fingerprint;

fn build_identity() {
    use std::process::Command;
    fn git(args: &[&str]) -> Option<String> {
        let output = Command::new("git").args(args).output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
    // Captured only when the fingerprint paths change. Not wired to git refs:
    // those are shared by every worktree and would cold-rebuild the agent target.
    let hash = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let date = std::env::var("SOURCE_DATE_EPOCH").unwrap_or_else(|_| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("build time")
            .as_secs()
            .to_string()
    });
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    for path in build_fingerprint::RERUN_PATHS {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rustc-env=ADE_BUILD_HASH={hash}");
    println!("cargo:rustc-env=ADE_BUILD_DATE={date}");
}

fn embed_test_manifest() {
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let manifest = std::path::Path::new("windows/test-comctl.manifest");
    println!("cargo:rerun-if-changed=windows/test-comctl.manifest");

    let manifest = std::fs::canonicalize(manifest).unwrap_or_else(|e| {
        panic!("no se pudo resolver {}: {e}", manifest.display());
    });
    let rc_path = out_dir.join("test-comctl.rc");
    let escaped = manifest.display().to_string().replace('\\', "\\\\");
    std::fs::write(&rc_path, format!("1 24 \"{escaped}\"\n")).expect("escribir el .rc");

    let res_path = out_dir.join("test-comctl.res");
    let rc = cc::windows_registry::find_tool("x86_64-pc-windows-msvc", "rc.exe")
        .expect("rc.exe del Windows SDK");
    let rc_status = rc
        .to_command()
        .arg("/nologo")
        .arg(format!("/fo{}", res_path.display()))
        .arg(&rc_path)
        .status()
        .expect("ejecutar rc.exe");
    if !rc_status.success() {
        panic!("rc.exe falló al compilar el manifiesto de tests");
    }

    let lib_path = out_dir.join("ade_test_manifest.lib");
    let lib = cc::windows_registry::find_tool("x86_64-pc-windows-msvc", "lib.exe")
        .expect("lib.exe de MSVC");
    let lib_status = lib
        .to_command()
        .arg("/nologo")
        .arg(format!("/OUT:{}", lib_path.display()))
        .arg(&res_path)
        .status()
        .expect("ejecutar lib.exe");
    if !lib_status.success() {
        panic!("lib.exe falló al armar ade_test_manifest.lib");
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
}
