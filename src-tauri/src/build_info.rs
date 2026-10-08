//! Shared app/CLI build identity and bounded inspection of the adjacent CLI.
use serde_json::{Value, json};
use std::{
    io::Read,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

pub fn current() -> Value {
    json!({"version":env!("CARGO_PKG_VERSION"),"buildHash":env!("ADE_BUILD_HASH"),"buildDate":env!("ADE_BUILD_DATE")})
}

fn compare(app: &Value, cli: Option<&Value>) -> bool {
    let Some(cli) = cli else {
        return true;
    };
    for field in ["version", "buildHash"] {
        if cli[field].as_str().is_none() || cli[field] != app[field] {
            return true;
        }
    }
    match (
        app["buildDate"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok()),
        cli["buildDate"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok()),
    ) {
        (Some(app), Some(cli)) => cli < app,
        _ => true,
    }
}

fn read_cli(path: &Path) -> Result<Value, String> {
    let mut command = crate::util::spawn::hidden_command(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!("CLI exited with {status}"));
                }
                let mut bytes = Vec::new();
                child
                    .stdout
                    .take()
                    .ok_or("Missing CLI output")?
                    .take(8193)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > 8192 {
                    return Err("CLI version output too large".into());
                }
                return serde_json::from_slice(&bytes).map_err(|e| e.to_string());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(e) => e.to_string(),
                    _ => "CLI version check timed out".into(),
                });
            }
        }
    }
}

fn status_at(path: &Path) -> Value {
    let app = current();
    let (cli, reason) = match read_cli(path) {
        Ok(cli) => (Some(cli), None),
        Err(e) => (None, Some(e)),
    };
    json!({"outdated":compare(&app,cli.as_ref()),"app":app,"cli":cli,"path":path.to_string_lossy(),"reason":reason})
}

#[tauri::command]
pub async fn cli_build_status() -> Result<Value, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = executable
        .parent()
        .ok_or("Missing app directory")?
        .join(if cfg!(windows) { "ags.exe" } else { "ags" });
    tauri::async_runtime::spawn_blocking(move || status_at(&path))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compares_legacy_hash_version_and_build_date() {
        let app = json!({"version":"1","buildHash":"abc","buildDate":"200"});
        assert!(compare(&app, None));
        assert!(compare(&app, Some(&json!({"version":"1","protocol":1}))));
        assert!(!compare(&app, Some(&app)));
        for patch in [
            json!({"version":"0"}),
            json!({"buildHash":"old"}),
            json!({"buildDate":"199"}),
            json!({"buildDate":"invalid"}),
        ] {
            let mut cli = app.clone();
            for (key, value) in patch.as_object().unwrap() {
                cli[key] = value.clone();
            }
            assert!(compare(&app, Some(&cli)));
        }
        assert!(!compare(
            &app,
            Some(&json!({"version":"1","buildHash":"abc","buildDate":"201"}))
        ));
    }
    #[test]
    fn missing_adjacent_cli_is_reported() {
        let path = std::env::temp_dir().join(format!("missing-ags-{}", uuid::Uuid::new_v4()));
        let status = status_at(&path);
        assert_eq!(status["outdated"], true);
        assert!(status["cli"].is_null());
        assert!(status["reason"].as_str().is_some());
    }
}
