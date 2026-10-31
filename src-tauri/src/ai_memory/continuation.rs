//! Wrapper somente para um novo PTY explicitamente confirmado pela pessoa.
use std::path::Path;

pub(crate) fn argv(
    binary: &Path,
    executable: &Path,
    native: &[String],
    extra: &[String],
) -> Result<Vec<String>, String> {
    if native.is_empty() || super::tabs::agent_from_program(&native[0]) != Some("claude") {
        return Err("A continuidade está disponível apenas com destino Claude.".into());
    }
    let mut args = vec![
        crate::util::external_path(binary)
            .to_string_lossy()
            .into_owned(),
        "run".into(),
        "--no-autowire".into(),
        "--no-exit-prompt".into(),
        "--require-server".into(),
        "--executable".into(),
        crate::util::external_path(executable)
            .to_string_lossy()
            .into_owned(),
        "claude".into(),
    ];
    // `--no-autowire` não injeta settings/MCP: conservamos os nossos, uma vez.
    args.extend_from_slice(&native[1..]);
    args.extend_from_slice(extra);
    Ok(args)
}
