//! Spill das respostas grandes do `ags` e do MCP (ponto 3 do deepseek-harness).
//!
//! Acima de [`SPILL_TOKENS`] (estimados a 4 bytes por token), o texto inteiro vai para
//! `<ags_home>/spill/<sessão>/<aleatório>.txt` e o agente recebe a cabeça, a cauda e o caminho, para
//! ler o resto com read/grep. Nada se perde e o contexto do agente não lota.
//!
//! Saída de terminal pode ter segredo, então:
//! - a pasta da sessão é 0700 e o arquivo 0600, criado com `create_new` e nome aleatório (Unix; no
//!   Windows vale a ACL do perfil do usuário);
//! - nunca dentro de um repositório: se a raiz cair num checkout git abaixo do home, não há spill e
//!   a resposta vai inteira, como antes;
//! - o que tem mais de [`KEEP_DAYS`] dias sai na próxima gravação.
//!
//! A "sessão" é a aba (`ADE_TAB_ID`) ou a tarefa da frota, só com `[A-Za-z0-9_-]`. Nunca o
//! `ADE_SESSION`, que é credencial.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

/// Acima disto (tokens estimados) a resposta vai para o disco.
pub const SPILL_TOKENS: usize = 6_000;
const BYTES_PER_TOKEN: usize = 4;
/// Quanto do começo e do fim fica na resposta.
pub const HEAD_CHARS: usize = 3_000;
pub const TAIL_CHARS: usize = 2_000;
pub const KEEP_DAYS: u64 = 30;

/// Os comandos da CLI cuja resposta passa pelo spill.
pub const CLI_COMMANDS: &[&str] = &["tab.output", "tab.screen", "peer.check", "peer.pending", "chat.show", "chat.wait", "recall.get"];

pub fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(BYTES_PER_TOKEN)
}

pub fn over_limit(text: &str) -> bool {
    estimate_tokens(text) > SPILL_TOKENS
}

/// A raiz dos spills desta instância. Nos testes, uma pasta temporária: teste nunca toca `~/.ags`.
pub fn root() -> Option<PathBuf> {
    if cfg!(test) {
        return Some(std::env::temp_dir().join(format!("ade-spill-test-{}", std::process::id())));
    }
    crate::util::datadir::ags_home().map(|home| home.join("spill"))
}

/// O nome da pasta da sessão: só letras, números, `_` e `-`; vazio vira `sem-sessao`. Pura.
pub fn session_dir_name(raw: Option<&str>) -> String {
    let clean: String = raw.unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(64).collect();
    if clean.is_empty() { "sem-sessao".into() } else { clean }
}

/// `true` se `root` fica dentro de um checkout git abaixo de `home` (onde o spill não pode ir).
pub fn inside_repo(root: &Path, home: Option<&Path>) -> bool {
    root.ancestors().any(|dir| home.is_none_or(|h| dir != h && dir.starts_with(h)) && dir.join(".git").exists())
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Grava `text` num arquivo novo e privado da sessão e devolve o caminho.
pub fn write(root: &Path, session: &str, text: &str) -> std::io::Result<PathBuf> {
    private_dir(root)?;
    let dir = root.join(session_dir_name(Some(session)));
    private_dir(&dir)?;
    let path = dir.join(format!("{}.txt", uuid::Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(text.as_bytes())?;
    Ok(path)
}

/// Apaga os spills com mais de `max_age` e as pastas de sessão que ficaram vazias. Devolve quantos
/// arquivos saíram. Erros de um arquivo não param os outros.
pub fn cleanup(root: &Path, now: SystemTime, max_age: Duration) -> usize {
    let mut removed = 0;
    let Ok(sessions) = fs::read_dir(root) else { return 0 };
    for session in sessions.flatten() {
        let dir = session.path();
        if !dir.is_dir() {
            continue;
        }
        if let Ok(files) = fs::read_dir(&dir) {
            for file in files.flatten() {
                let old = file.metadata().and_then(|m| m.modified()).ok().and_then(|at| now.duration_since(at).ok()).is_some_and(|age| age > max_age);
                if old && fs::remove_file(file.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        let _ = fs::remove_dir(&dir); // só sai se estiver vazia
    }
    removed
}

fn head_tail(text: &str) -> (&str, &str) {
    let head_end = text.char_indices().nth(HEAD_CHARS).map_or(text.len(), |(i, _)| i);
    let count = text.chars().count();
    let tail_start = if count > HEAD_CHARS + TAIL_CHARS {
        text.char_indices().nth(count - TAIL_CHARS).map_or(text.len(), |(i, _)| i)
    } else {
        head_end
    };
    (&text[..head_end], &text[tail_start.max(head_end)..])
}

/// O texto que volta no lugar do inteiro: cabeça, o aviso com o caminho e a cauda. Pura.
pub fn shrink(text: &str, path: &Path) -> String {
    let (head, tail) = head_tail(text);
    let omitted = text.len() - head.len() - tail.len();
    format!(
        "{head}\n\n[… {omitted} bytes omitidos (~{} tokens no total). O texto inteiro está em {} — leia com read/grep; não peça de novo.]\n\n{tail}",
        estimate_tokens(text),
        path.display()
    )
}

/// Grava e encolhe, se passar do limite e houver onde gravar. `None` = devolva o texto como está.
pub fn spill_text(root: Option<&Path>, session: &str, text: &str) -> Option<(String, PathBuf)> {
    if !over_limit(text) {
        return None;
    }
    let root = root?;
    if inside_repo(root, dirs::home_dir().as_deref()) {
        return None;
    }
    let path = write(root, session, text).ok()?;
    cleanup(root, SystemTime::now(), Duration::from_secs(KEEP_DAYS * 24 * 60 * 60));
    Some((shrink(text, &path), path))
}

/// Encolhe cada string grande de um JSON no lugar, sem mudar a forma, e anota em `spilled` (na raiz,
/// se for objeto) o campo e o arquivo. Se mesmo assim o JSON inteiro passar do limite (muitas
/// strings pequenas), ele todo vai para o disco e a resposta vira `{spilled, head, tail}`.
pub fn spill_json(root: Option<&Path>, session: &str, value: &mut Value) {
    let Some(root) = root else { return };
    if !over_limit(&value.to_string()) {
        return;
    }
    let mut spilled = Vec::new();
    walk(root, session, value, "", &mut spilled);
    if !spilled.is_empty()
        && let Some(map) = value.as_object_mut()
    {
        map.insert("spilled".into(), json!(spilled));
    }
    let whole = value.to_string();
    if let Some((_, path)) = spill_text(Some(root), session, &whole) {
        let (head, tail) = head_tail(&whole);
        *value = json!({
            "spilled": [{ "field": "", "path": path.display().to_string(), "bytes": whole.len(), "format": "json" }],
            "head": head, "tail": tail,
            "note": format!("Resposta grande demais: o JSON inteiro está em {}. Leia com read/grep.", path.display()),
        });
    }
}

fn walk(root: &Path, session: &str, value: &mut Value, at: &str, spilled: &mut Vec<Value>) {
    match value {
        Value::String(text) => {
            if let Some((short, path)) = spill_text(Some(root), session, text) {
                spilled.push(json!({ "field": at, "path": path.display().to_string(), "bytes": text.len() }));
                *text = short;
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter_mut().enumerate() {
                walk(root, session, item, &format!("{at}/{i}"), spilled);
            }
        }
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                walk(root, session, item, &format!("{at}/{key}"), spilled);
            }
        }
        _ => {}
    }
}

/// O resultado de uma tool do MCP: cada bloco de texto grande vai para o disco.
pub fn spill_tool_result(root: Option<&Path>, session: &str, result: &mut Value) {
    let Some(items) = result.get_mut("content").and_then(Value::as_array_mut) else { return };
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str)
            && let Some((short, _)) = spill_text(root, session, text)
        {
            item["text"] = json!(short);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ade-spill-{name}-{}", uuid::Uuid::new_v4().simple()));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn big() -> String {
        (0..(SPILL_TOKENS * BYTES_PER_TOKEN / 10 + 50)).map(|i| format!("linha {i:03}\n")).collect()
    }

    #[test]
    fn texto_pequeno_nao_vai_para_o_disco() {
        let root = fresh_root("pequeno");
        assert!(spill_text(Some(&root), "tab-1", "oi").is_none());
        assert!(!root.exists());
    }

    #[test]
    fn texto_grande_vira_cabeca_cauda_e_caminho_privado() {
        let root = fresh_root("grande");
        let text = big();
        let (short, path) = spill_text(Some(&root), "tab/../1", &text).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text, "nada se perde");
        assert!(path.starts_with(root.join("tab1")), "a sessão é saneada: {}", path.display());
        assert!(short.starts_with("linha 000") && short.trim_end().ends_with(text.trim_end().lines().last().unwrap()));
        assert!(short.contains(&path.display().to_string()) && short.len() < text.len());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let (_, other) = spill_text(Some(&root), "tab/../1", &text).unwrap();
        assert_ne!(path, other, "nome aleatório, um arquivo por resposta");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nunca_dentro_de_um_repositorio() {
        let home = fresh_root("home");
        let repo = home.join("projeto");
        fs::create_dir_all(repo.join(".git")).unwrap();
        assert!(inside_repo(&repo.join(".ags/spill"), Some(&home)));
        assert!(!inside_repo(&home.join(".ags/spill"), Some(&home)));
        fs::create_dir_all(home.join(".git")).unwrap();
        assert!(!inside_repo(&home.join(".ags/spill"), Some(&home)), "o home com dotfiles em git não conta");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn limpeza_tira_so_o_que_passou_de_trinta_dias() {
        let root = fresh_root("limpeza");
        let path = write(&root, "tab-1", "segredo").unwrap();
        let day = Duration::from_secs(24 * 60 * 60);
        let max = Duration::from_secs(KEEP_DAYS * 24 * 60 * 60);
        assert_eq!(cleanup(&root, SystemTime::now() + 29 * day, max), 0);
        assert!(path.exists());
        assert_eq!(cleanup(&root, SystemTime::now() + 31 * day, max), 1);
        assert!(!path.exists() && !path.parent().unwrap().exists(), "pasta vazia sai junto");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn json_mantem_a_forma_e_diz_onde_ficou_cada_campo() {
        let root = fresh_root("json");
        let mut value = json!({ "tabId": "t1", "text": big(), "lines": 3 });
        spill_json(Some(&root), "t1", &mut value);
        assert_eq!(value["tabId"], "t1");
        assert_eq!(value["lines"], 3);
        assert_eq!(value["spilled"][0]["field"], "/text");
        let path = value["spilled"][0]["path"].as_str().unwrap();
        assert!(Path::new(path).exists());
        let mut many = json!({ "items": (0..4000).map(|i| json!({ "id": i, "t": "abcdefgh" })).collect::<Vec<_>>() });
        spill_json(Some(&root), "t1", &mut many);
        assert_eq!(many["spilled"][0]["format"], "json");
        assert!(many["head"].as_str().unwrap().starts_with("{\"items\""));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resultado_do_mcp_encolhe_so_os_blocos_de_texto_grandes() {
        let root = fresh_root("mcp");
        let mut result = json!({ "content": [{ "type": "text", "text": big() }, { "type": "text", "text": "curto" }] });
        spill_tool_result(Some(&root), "task-9", &mut result);
        let first = result["content"][0]["text"].as_str().unwrap();
        assert!(first.contains("bytes omitidos") && first.contains("task-9"));
        assert_eq!(result["content"][1]["text"], "curto");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cabeca_e_cauda_respeitam_caracteres_multibyte() {
        let text = "é".repeat(HEAD_CHARS + TAIL_CHARS + 10);
        let (head, tail) = head_tail(&text);
        assert_eq!(head.chars().count(), HEAD_CHARS);
        assert_eq!(tail.chars().count(), TAIL_CHARS);
    }
}
