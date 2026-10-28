//! Ferramentas do Jev: o caminho que um `ags portal act … --save <nome>` achou, guardado como JSON em
//! `~/.ags/jev-tools/<nome>.json` (a pasta é da pessoa: dá para ler, copiar e apagar à mão). Quem grava e quem
//! reproduz é o frontend (`src/features/browser/jevTools.ts`); aqui só se guarda, lista e apaga.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Mesmo formato do frontend (`TOOL_NAME`): começa com letra minúscula; só minúsculas, dígitos e `_`.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && name.len() <= 48
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn check_name(name: &str) -> Result<(), String> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(format!("O nome \"{name}\" não serve: comece com letra minúscula e use só minúsculas, dígitos e _."))
    }
}

pub fn dir() -> Result<PathBuf, String> {
    crate::util::datadir::ags_home()
        .map(|home| home.join("jev-tools"))
        .ok_or_else(|| "Não foi possível localizar a pasta do usuário.".into())
}

/// Confere o mínimo que o frontend precisa para reproduzir (o resto ele mesmo valida).
fn check_tool(tool: &Value) -> Result<String, String> {
    let name = tool.get("name").and_then(Value::as_str).ok_or("A ferramenta não tem nome.")?;
    check_name(name)?;
    if tool.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Versão de ferramenta desconhecida.".into());
    }
    if tool.get("authority").and_then(Value::as_str) != Some("read") {
        return Err("Só ferramentas de leitura são aceitas por enquanto.".into());
    }
    let start = tool.get("startUrl").and_then(Value::as_str).unwrap_or_default();
    if !(start.starts_with("http://") || start.starts_with("https://")) {
        return Err("A ferramenta não diz de que página começa.".into());
    }
    if !tool.get("steps").is_some_and(Value::is_array) {
        return Err("A ferramenta não tem passos.".into());
    }
    Ok(name.to_string())
}

pub fn save_in(root: &Path, tool: &Value, replace: bool) -> Result<PathBuf, String> {
    let name = check_tool(tool)?;
    std::fs::create_dir_all(root).map_err(|e| format!("Não deu para criar {}: {e}", root.display()))?;
    let path = root.join(format!("{name}.json"));
    if path.exists() && !replace {
        return Err(format!("Já existe uma ferramenta {name}. Use --replace para gravar por cima, ou outro nome."));
    }
    let text = serde_json::to_string_pretty(tool).map_err(|e| e.to_string())?;
    // Escreve ao lado e troca: uma ferramenta nunca fica pela metade.
    let tmp = root.join(format!(".{name}.json.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn load_in(root: &Path, name: &str) -> Result<Value, String> {
    check_name(name)?;
    let path = root.join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).map_err(|_| {
        format!("Não existe a ferramenta {name}. Veja as que existem com `ags portal tools`.")
    })?;
    let tool: Value = serde_json::from_str(&text).map_err(|e| format!("{}: JSON inválido ({e})", path.display()))?;
    check_tool(&tool)?;
    Ok(tool)
}

pub fn list_in(root: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut tools: Vec<Value> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().strip_suffix(".json")?.to_string();
            let tool = load_in(root, &name).ok()?;
            Some(serde_json::json!({
                "name": name,
                "goal": tool.get("goal").cloned().unwrap_or(Value::Null),
                "startUrl": tool.get("startUrl").cloned().unwrap_or(Value::Null),
                "inputs": tool.get("inputs").cloned().unwrap_or(Value::Array(Vec::new())),
                "steps": tool.get("steps").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                "read": tool.pointer("/read/kind").cloned().unwrap_or(Value::Null),
                "createdAt": tool.get("createdAt").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect();
    tools.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    tools
}

pub fn delete_in(root: &Path, name: &str) -> Result<(), String> {
    check_name(name)?;
    std::fs::remove_file(root.join(format!("{name}.json")))
        .map_err(|_| format!("Não existe a ferramenta {name}."))
}

/// O frontend salva ao fim de um `act --save` que deu certo.
#[tauri::command]
pub fn jev_tool_save(tool: Value, replace: bool) -> Result<String, String> {
    save_in(&dir()?, &tool, replace).map(|p| p.display().to_string())
}

#[cfg(test)]
mod test;
