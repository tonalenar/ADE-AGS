//! Leitura e ajuste explícito de `[maintenance].forget_sweep_interval_secs` no `config.toml` do ai-memory.
//! A ADE só lê esse campo para avisar o usuário e só grava após clique e confirmação explícita,
//! preservando comentários, formatação e o restante do arquivo.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::types::ForgetSweepStatus;

const MAX_CONFIG_BYTES: usize = 2 * 1024 * 1024;

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.toml")
}

fn read_text(path: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| format!("Não foi possível abrir a configuração do ai-memory: {e}"))?
        .take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Não foi possível ler a configuração do ai-memory: {e}"))?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("O arquivo config.toml do ai-memory excedeu 2 MiB.".into());
    }
    String::from_utf8(bytes)
        .map_err(|_| "O arquivo config.toml do ai-memory não é UTF-8 válido.".to_string())
}

fn parse_toml(text: &str) -> Result<toml_edit::DocumentMut, String> {
    text.trim_start_matches('\u{feff}')
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Não foi possível interpretar o config.toml do ai-memory: {e}"))
}

fn read_interval(doc: &toml_edit::DocumentMut) -> Option<i64> {
    doc.get("maintenance")
        .and_then(|table| table.get("forget_sweep_interval_secs"))
        .and_then(|item| item.as_integer())
}

/// Atualiza `forget_sweep_interval_secs = 0` na seção `[maintenance]` preservando o resto do texto.
fn set_forget_sweep_zero_preserving_text(original: &str) -> String {
    let eol = if original.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let had_trailing_newline = original.ends_with('\n');
    let mut lines: Vec<String> = original
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    if had_trailing_newline && lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }

    let mut in_maintenance = false;
    let mut found_maintenance = false;
    let mut maintenance_end: Option<usize> = None;
    let mut replaced = false;

    for (idx, line) in lines.iter_mut().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && !trimmed.starts_with("[[") {
            if let Some(end_bracket) = trimmed.find(']') {
                let header = trimmed[1..end_bracket].trim();
                let is_maint = header == "maintenance";
                if in_maintenance && !is_maint && maintenance_end.is_none() {
                    maintenance_end = Some(idx);
                }
                in_maintenance = is_maint;
                if is_maint {
                    found_maintenance = true;
                }
                continue;
            }
        } else if trimmed.starts_with("[[") {
            if in_maintenance && maintenance_end.is_none() {
                maintenance_end = Some(idx);
            }
            in_maintenance = false;
            continue;
        }

        if in_maintenance && !trimmed.starts_with('#') {
            if let Some((lhs, rhs)) = line.split_once('=') {
                if lhs.trim() == "forget_sweep_interval_secs" {
                    let indent_len = line.len() - line.trim_start().len();
                    let indent = &line[..indent_len];
                    let comment = rhs
                        .find('#')
                        .map(|pos| format!(" {}", rhs[pos..].trim()))
                        .unwrap_or_default();
                    *line = format!("{indent}forget_sweep_interval_secs = 0{comment}");
                    replaced = true;
                    break;
                }
            }
        }
    }

    if !replaced {
        if found_maintenance {
            let insert_at = maintenance_end.unwrap_or(lines.len());
            lines.insert(insert_at, "forget_sweep_interval_secs = 0".to_string());
        } else {
            if !lines.is_empty() && !lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push("[maintenance]".to_string());
            lines.push("forget_sweep_interval_secs = 0".to_string());
        }
    }

    let mut out = lines.join(eol);
    out.push_str(eol);
    out
}

/// Lê somente o estado de `[maintenance].forget_sweep_interval_secs`.
/// Quando o arquivo ou a chave não existem, o padrão do ai-memory é ligado (24 h = 86400 s).
pub(super) fn read_forget_sweep(data_dir: &Path) -> Result<ForgetSweepStatus, String> {
    let path = config_path(data_dir);
    let path_str = path.display().to_string();
    if !path.exists() {
        return Ok(ForgetSweepStatus {
            enabled: true,
            interval_secs: None,
            config_path: path_str,
            config_exists: false,
        });
    }
    let text = read_text(&path)?;
    let doc = parse_toml(&text)?;
    let (enabled, interval_secs) = match read_interval(&doc) {
        Some(v) if v <= 0 => (false, Some(0)),
        Some(v) => (true, Some(v as u64)),
        None => (true, None),
    };
    Ok(ForgetSweepStatus {
        enabled,
        interval_secs,
        config_path: path_str,
        config_exists: true,
    })
}

/// Define `[maintenance].forget_sweep_interval_secs = 0` no `config.toml` do ai-memory,
/// preservando todo o restante do arquivo (comentários, ordem e demais seções).
/// Deve ser chamada exclusivamente após confirmação explícita do usuário.
pub(super) fn disable_forget_sweep(data_dir: &Path) -> Result<ForgetSweepStatus, String> {
    let path = config_path(data_dir);
    let path_str = path.display().to_string();

    let (rendered, existing_perms) = if path.exists() {
        let perms = fs::metadata(&path)
            .map_err(|e| format!("Não foi possível ler os metadados de config.toml: {e}"))?
            .permissions();
        let original = read_text(&path)?;
        let doc = parse_toml(&original)?;
        if let Some(item) = doc.get("maintenance")
            && item.as_table_like().is_none()
        {
            return Err("A chave [maintenance] em config.toml não é uma tabela válida.".into());
        }
        if read_interval(&doc).is_some_and(|v| v <= 0) {
            return Ok(ForgetSweepStatus {
                enabled: false,
                interval_secs: Some(0),
                config_path: path_str,
                config_exists: true,
            });
        }
        let updated = set_forget_sweep_zero_preserving_text(&original);
        let verified = parse_toml(&updated)?;
        if read_interval(&verified) != Some(0) {
            return Err(
                "Não foi possível confirmar forget_sweep_interval_secs = 0 após atualizar config.toml."
                    .into(),
            );
        }
        (updated, Some(perms))
    } else {
        fs::create_dir_all(data_dir)
            .map_err(|e| format!("Não foi possível criar a pasta de dados do ai-memory: {e}"))?;
        ("[maintenance]\nforget_sweep_interval_secs = 0\n".to_string(), None)
    };

    let tmp_path = data_dir.join(format!("config.toml.ade-tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp_path, rendered.as_bytes())
        .map_err(|e| format!("Não foi possível gravar o arquivo temporário de config.toml: {e}"))?;
    if let Some(perms) = existing_perms {
        let _ = fs::set_permissions(&tmp_path, perms);
    }
    if let Err(e) = fs::rename(&tmp_path, &path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Não foi possível atualizar o config.toml do ai-memory: {e}"));
    }

    Ok(ForgetSweepStatus {
        enabled: false,
        interval_secs: Some(0),
        config_path: path_str,
        config_exists: true,
    })
}
