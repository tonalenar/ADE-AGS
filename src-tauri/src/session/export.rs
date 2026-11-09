//! Exportación de una sesión archivada a markdown.
//!
//! El export tiene dos partes independientes: la metadata (que siempre sale, porque la
//! tiene la app) y la transcripción de la conversación (que sale de leer el archivo de
//! sesión del agente y puede no estar disponible: la sesión pudo no resolver nunca su id,
//! o el CLI pudo haber borrado/rotado su historial). Cuando la transcripción no se puede
//! leer, se exporta igual con la metadata y una nota explicando por qué falta — es más
//! útil que fallar.

use crate::database::{ArchivedSkill, DbConnection, SessionHistoryEntry, SiblingTab};
use rusqlite::OptionalExtension;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Un turno de la conversación, ya normalizado.
#[derive(Clone)]
pub(crate) struct Turn {
    pub(crate) role: String,
    pub(crate) text: String,
    /// Índice estável da fonte (ID Hermes ou posição em JSONL/OpenCode).
    pub(crate) source_index: Option<i64>,
    /// ID estável da mensagem OpenCode, quando a fonte o fornece.
    pub(crate) source_id: Option<String>,
    /// Informa se a fonte precisou cortar o corpo antes de normalizar a fala.
    pub(crate) truncated: bool,
}

/// Lê a conversa principal de uma sessão Kimi para a busca arquivada. O `wire.jsonl` é
/// também um log de ferramentas e replay; somente prompts digitados e texto visível do
/// agente entram no índice volátil. A prévia resolve pelo ID da fonte, nunca por posição.
pub(crate) fn extract_kimi_transcript_for_search(
    session_id: &str,
    cwd: &str,
    source_id: Option<&str>,
) -> Result<(Vec<Turn>, bool), String> {
    const MAX_BYTES: u64 = 4 * 1024 * 1024;
    const MAX_LINE_BYTES: usize = 256 * 1024;

    let path = super::title::kimi_wire_file_for_search(session_id, cwd)
        .ok_or_else(|| "A sessão Kimi não pertence a esta pasta ou não está disponível".to_string())?;
    let mut file = std::fs::File::open(path)
        .map_err(|_| "Não foi possível abrir o histórico da sessão Kimi".to_string())?;
    let file_len = file
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    let mut partial = file_len > MAX_BYTES;
    let mut start_offset = file_len.saturating_sub(MAX_BYTES);
    if partial {
        file.seek(SeekFrom::End(-(MAX_BYTES as i64)))
            .map_err(|error| error.to_string())?;
    }
    let mut bytes = Vec::with_capacity(MAX_BYTES as usize + 1);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES as usize {
        let excess = bytes.len() - MAX_BYTES as usize;
        bytes.drain(..excess);
        start_offset = start_offset.saturating_add(excess as u64);
        partial = true;
    }
    if partial {
        if let Some(line_end) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=line_end);
            start_offset = start_offset.saturating_add(line_end as u64 + 1);
        } else {
            if source_id.is_some() {
                return Err("A fala Kimi não está no trecho seguro de leitura".into());
            }
            return Ok((Vec::new(), true));
        }
    }
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        if let Some(line_end) = bytes.iter().rposition(|byte| *byte == b'\n') {
            bytes.truncate(line_end + 1);
        } else {
            bytes.clear();
        }
        partial = true;
    }

    let (turns, parse_partial) =
        parse_kimi_wire_for_search(&bytes, start_offset, MAX_LINE_BYTES)?;
    if let Some(source_id) = source_id {
        if source_id.len() > 128
            || !(source_id.starts_with("kimi:user:") || source_id.starts_with("kimi:event:"))
        {
            return Err("A fala Kimi não tem um ID de fonte válido".into());
        }
        let mut matching_turns = turns
            .iter()
            .filter(|turn| turn.source_id.as_deref() == Some(source_id));
        if matching_turns.next().is_none() || matching_turns.next().is_some() {
            return Err("A fala Kimi não está mais disponível de forma inequívoca".into());
        }
    }
    Ok((turns, partial || parse_partial))
}

fn parse_kimi_wire_for_search(
    bytes: &[u8],
    start_offset: u64,
    max_line_bytes: usize,
) -> Result<(Vec<Turn>, bool), String> {
    let mut turns = Vec::new();
    let mut partial = false;
    let mut turn_counter = KimiTurnCounter::default();
    let mut offset = start_offset;
    let mut source_ids = std::collections::HashSet::new();

    for record_bytes in bytes.split_inclusive(|byte| *byte == b'\n') {
        let line_offset = offset;
        offset = offset.saturating_add(record_bytes.len() as u64);
        let raw_line = record_bytes.strip_suffix(b"\n").unwrap_or(record_bytes);
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if line.len() > max_line_bytes {
            partial = true;
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            partial = true;
            continue;
        };
        let Some(record_type) = record.get("type").and_then(Value::as_str) else {
            partial = true;
            continue;
        };

        let mut extracted: Option<(String, String, &'static str)> = None;
        let effect = match record_type {
            "context.append_message" => {
                let Some(message) = record.get("message") else { continue };
                match message.get("role").and_then(Value::as_str) {
                    Some("assistant") => KimiTurnEffect::Ensure,
                    Some("user") => {
                        let (searchable, effect) = kimi_user_origin(message.get("origin"));
                        if searchable
                            && let Some(text) = kimi_text_content(message.get("content"))
                        {
                            let text = text.trim().to_string();
                            if !text.is_empty() {
                                extracted = Some(("user".into(), text, "kimi:user:"));
                            }
                        }
                        effect
                    }
                    _ => KimiTurnEffect::None,
                }
            }
            "context.undo" => {
                let count = record
                    .get("count")
                    .and_then(Value::as_u64)
                    .filter(|count| *count > 0 && *count <= 9_007_199_254_740_991)
                    .and_then(|count| usize::try_from(count).ok())
                    .unwrap_or(0);
                if count == 0 { KimiTurnEffect::None } else { KimiTurnEffect::Undo(count) }
            }
            "context.append_loop_event" => {
                let Some(event) = record.get("event") else { continue };
                match event.get("type").and_then(Value::as_str) {
                    Some("content.part") => {
                        let Some(part) = event.get("part").and_then(Value::as_object) else {
                            continue;
                        };
                        let part_type = part.get("type").and_then(Value::as_str);
                        if part_type == Some("text") {
                            let Some(text) = part.get("text").and_then(Value::as_str) else {
                                continue;
                            };
                            let text = text.trim();
                            if !text.is_empty() {
                                extracted = Some(("assistant".into(), text.to_string(), "kimi:event:"));
                                KimiTurnEffect::Ensure
                            } else {
                                KimiTurnEffect::None
                            }
                        } else if part_type == Some("think") {
                            let has_thinking = part
                                .get("think")
                                .and_then(Value::as_str)
                                .is_some_and(|think| !think.trim().is_empty())
                                || part.get("encrypted").is_some();
                            if has_thinking { KimiTurnEffect::Ensure } else { KimiTurnEffect::None }
                        } else {
                            KimiTurnEffect::Ensure
                        }
                    }
                    Some("tool.call") => KimiTurnEffect::Ensure,
                    _ => KimiTurnEffect::None,
                }
            }
            _ => KimiTurnEffect::None,
        };

        let source_index = advance_kimi_turn_counter(&mut turn_counter, effect);
        if let Some((role, text, id_prefix)) = extracted {
            let source_id = kimi_wire_source_id(id_prefix, line_offset, raw_line);
            if !source_ids.insert(source_id.clone()) {
                return Err("O histórico Kimi contém IDs de fala duplicados".into());
            }
            turns.push(Turn {
                role,
                text,
                source_index,
                source_id: Some(source_id),
                truncated: false,
            });
        }
    }
    Ok((turns, partial))
}

#[derive(Default)]
struct KimiTurnCounter {
    next: i64,
    has_turn: bool,
    openers: Vec<(i64, bool)>,
}

enum KimiTurnEffect {
    Open(bool),
    Ensure,
    Undo(usize),
    None,
}

fn advance_kimi_turn_counter(
    state: &mut KimiTurnCounter,
    effect: KimiTurnEffect,
) -> Option<i64> {
    match effect {
        KimiTurnEffect::Open(anchor) => {
            let doc_turn = state.next;
            state.next = state.next.saturating_add(1);
            state.has_turn = true;
            state.openers.push((doc_turn, anchor));
            Some(doc_turn)
        }
        KimiTurnEffect::Ensure => {
            if !state.has_turn {
                state.next = state.next.saturating_add(1);
                state.has_turn = true;
            }
            Some(state.next.saturating_sub(1))
        }
        KimiTurnEffect::Undo(count) => {
            let mut found = 0;
            for index in (0..state.openers.len()).rev() {
                if state.openers[index].1 {
                    found += 1;
                    if found == count {
                        state.next = state.openers[index].0;
                        state.has_turn = index > 0;
                        state.openers.truncate(index);
                        break;
                    }
                }
            }
            None
        }
        KimiTurnEffect::None => None,
    }
}

fn kimi_user_origin(origin: Option<&Value>) -> (bool, KimiTurnEffect) {
    let origin = match origin {
        None | Some(Value::Null) => return (true, KimiTurnEffect::Open(true)),
        Some(Value::Object(origin)) => origin,
        Some(_) => return (false, KimiTurnEffect::None),
    };
    let kind_value = origin.get("kind");
    let kind = kind_value.and_then(Value::as_str);
    match kind {
        Some("injection" | "retry") => (false, KimiTurnEffect::None),
        Some("system_trigger") => {
            let name = origin.get("name").and_then(Value::as_str);
            let is_turn_opener = matches!(name, Some("goal_continuation" | "subagent"));
            (false, if is_turn_opener { KimiTurnEffect::Open(false) } else { KimiTurnEffect::None })
        }
        Some("skill_activation" | "plugin_command") => {
            let slash = origin.get("trigger").and_then(Value::as_str) == Some("user-slash");
            (slash, if slash { KimiTurnEffect::Open(true) } else { KimiTurnEffect::None })
        }
        Some("compaction_summary") => (false, KimiTurnEffect::None),
        _ => {
            // Só a ausência da chave equivale ao padrão `undefined` do Kimi. Um valor
            // presente com tipo inesperado continua sendo prompt textual, mas não ancora turno.
            let anchor = kind_value.is_none() || kind == Some("user");
            (true, KimiTurnEffect::Open(anchor))
        }
    }
}

fn kimi_text_content(content: Option<&Value>) -> Option<String> {
    let parts = content?.as_array()?;
    let mut text = String::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("text")
            && let Some(part_text) = part.get("text").and_then(Value::as_str)
            && !is_kimi_media_path_tag(part_text)
        {
            text.push_str(part_text);
        }
    }
    let trimmed = text.trim();
    (!trimmed.is_empty() && !is_kimi_media_path_tag(trimmed)).then(|| trimmed.to_string())
}

/// Media tags que ocupam todo o texto são referências a arquivos, não conteúdo textual
/// pesquisável. A forma segue `matchSingleMediaPathTag` do Kimi.
fn is_kimi_media_path_tag(text: &str) -> bool {
    let text = text.trim();
    let Some(open_end) = text.find('>') else { return false };
    let opening = &text[..=open_end];
    let Some(name) = ["image", "video", "audio", "file"]
        .into_iter()
        .find(|name| opening.starts_with(&format!("<{name}")))
    else {
        return false;
    };
    let after_name = opening.as_bytes().get(name.len() + 1).copied();
    if after_name.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
        return false;
    }

    let has_path = opening.match_indices("path=\"").any(|(index, _)| {
        let boundary = index == 0
            || !opening.as_bytes()[index - 1].is_ascii_alphanumeric()
                && opening.as_bytes()[index - 1] != b'_';
        boundary && opening[index + 6..].contains('"')
    });
    if !has_path {
        return false;
    }

    let tail = &text[open_end + 1..];
    tail.is_empty() || tail == format!("</{name}>")
}

fn kimi_wire_source_id(prefix: &str, offset: u64, raw_line: &[u8]) -> String {
    let digest = Sha256::digest(raw_line);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("{prefix}{offset}:{hex}")
}

/// Rol declarado en una línea del JSONL, mirando las formas que usan los CLIs soportados:
/// `{"role": "user"}` plano, o anidado bajo `message`/`payload`.
pub(super) fn role_of(v: &Value) -> Option<String> {
    for path in [vec!["role"], vec!["message", "role"], vec!["payload", "role"]] {
        if let Some(found) = dig(v, &path).and_then(|c| c.as_str()) {
            return Some(found.to_string());
        }
    }

    // Gemini CLI no guarda un `role`: marca cada línea con `type: "user" | "gemini"`. Sin
    // esta traducción sus sesiones no producían NINGÚN turno y el export salía vacío.
    //
    // Va último a propósito: Claude Code también usa `type: "user"`, pero ahí el rol real
    // está en `message.role` y ya se resolvió arriba. El resto de los `type` del ecosistema
    // (`summary`, `response_item`, `session_meta`, `event_msg`) no caen en este match.
    match v.get("type").and_then(|t| t.as_str()) {
        Some("user") => Some("user".to_string()),
        Some("gemini") => Some("assistant".to_string()),
        _ => None,
    }
}

/// Camina una ruta de claves anidadas. Devuelve `None` si la ruta no existe — sin
/// abortar la búsqueda de las OTRAS rutas que prueban los llamadores.
pub(super) fn dig<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

/// Texto de un bloque `content`, que según el agente es un string plano o un array de
/// bloques tipados (`text`, `input_text`, `output_text`).
pub(super) fn text_of_content(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        let trimmed = s.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    // Un bloque suelto (no una lista) también es válido: Gemini modela el contenido como
    // `Part | Part[] | string`.
    let single = std::slice::from_ref(content);
    let blocks = content.as_array().map(Vec::as_slice).unwrap_or(single);

    let joined: Vec<String> = blocks
        .iter()
        .filter_map(|b| {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") | Some("input_text") | Some("output_text") => {
                    b.get("text").and_then(|t| t.as_str()).map(|s| s.trim().to_string())
                }
                // Tipado como otra cosa (tool_use, thought…): no es conversación.
                Some(_) => None,
                // Sin `type` es un Part de Gemini: el texto está en `text`.
                None => b.get("text").and_then(|t| t.as_str()).map(|s| s.trim().to_string()),
            }
        })
        .filter(|s| !s.is_empty())
        .collect();
    (!joined.is_empty()).then(|| joined.join("\n\n"))
}

pub(super) fn content_of(v: &Value) -> Option<String> {
    for path in [vec!["content"], vec!["message", "content"], vec!["payload", "content"]] {
        if let Some(text) = dig(v, &path).and_then(text_of_content) {
            return Some(text);
        }
    }
    None
}

/// Contexto que el CLI se inyecta a sí mismo haciéndose pasar por el usuario.
///
/// Codex abre toda sesión con un `<environment_context>` (cwd, OS, política de sandbox) y,
/// si hay AGENTS.md, un `<user_instructions>`. Van con `role: "user"`, así que sin filtrarlos
/// el export empieza con dos bloques de XML que la persona nunca escribió.
pub(super) fn is_injected_context(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>")
        || t.starts_with("<user_instructions>")
        || t.starts_with("<environment_details>")
}

/// Lee un archivo de sesión JSONL y devuelve los turnos de usuario y asistente en orden.
/// Las líneas que no son mensajes (metadata, tool calls, deltas de streaming sin texto)
/// se saltean solas al no tener rol + contenido textual.
pub(super) fn extract_transcript(path: &Path) -> Vec<Turn> {
    let Ok(content) = std::fs::read_to_string(path) else { return Vec::new() };
    parse_transcript(&content)
}

/// Lê no máximo os 4 MiB mais recentes para o índice de busca. Exportação continua lendo
/// a sessão inteira; a busca mantém um teto previsível por sessão e sinaliza quando cortou.
pub(crate) fn extract_transcript_for_search(path: &Path) -> Result<(Vec<Turn>, bool), std::io::Error> {
    const MAX_BYTES: u64 = 4 * 1024 * 1024;
    let mut file = std::fs::File::open(path)?;
    let partial = file.metadata()?.len() > MAX_BYTES;
    if partial {
        file.seek(SeekFrom::End(-(MAX_BYTES as i64)))?;
    }

    let mut bytes = Vec::with_capacity(MAX_BYTES as usize + 1);
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if partial {
        if let Some(line_end) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=line_end);
        } else {
            return Ok((Vec::new(), true));
        }
    }
    let content = String::from_utf8_lossy(&bytes);
    Ok((parse_transcript(&content), partial))
}

/// Lê mensagens TUI arquivadas do Hermes sem gravá-las no banco da ADE. A consulta usa
/// apenas o state.db em modo somente leitura e valida o ID, a pasta e a origem da sessão.
/// `message_id` devolve uma fala específica para que a prévia continue apontando ao mesmo
/// registro caso outra ferramenta acrescente mensagens à sessão depois da indexação.
pub(crate) fn extract_hermes_transcript_for_search(
    session_id: &str,
    cwd: &str,
    message_id: Option<i64>,
) -> Result<(Vec<Turn>, bool), String> {
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    const MAX_MESSAGES: usize = 128;
    const MAX_MESSAGE_CHARS: usize = 16_000;

    let home = super::title::hermes_home(None);
    let conn = super::title::hermes_db(&home)
        .ok_or_else(|| "O banco local do Hermes não está disponível".to_string())?;
    // `SQLITE_LIMIT_LENGTH` limita qualquer valor ou linha que o SQLite materializa nesta
    // conexão. O filtro `octet_length(content)` também limita a soma dos corpos lidos na
    // sessão antes de `substr()`; medir o comprimento da coluna evita carregar corpos grandes.
    // O handle é emprestado da conexão.
    let max_value_bytes = i32::try_from(MAX_BYTES).expect("4 MiB cabe em i32");
    // SAFETY: `conn` permanece viva e é usada apenas nesta thread. `sqlite3_limit` recebe
    // o handle emprestado, altera somente o limite runtime desta conexão e não retém o
    // ponteiro; não há statements ativos nem uso concorrente do handle neste ponto.
    unsafe {
        let handle = conn.handle();
        let current_limit =
            rusqlite::ffi::sqlite3_limit(handle, rusqlite::ffi::SQLITE_LIMIT_LENGTH, -1);
        if current_limit > max_value_bytes {
            rusqlite::ffi::sqlite3_limit(
                handle,
                rusqlite::ffi::SQLITE_LIMIT_LENGTH,
                max_value_bytes,
            );
        }
    }
    let session = conn
        .query_row(
            "SELECT cwd, source FROM sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((Some(session_cwd), Some(source))) = session else {
        return Err("A sessão do Hermes não está disponível".into());
    };
    if !matches!(source.as_str(), "cli" | "tui")
        || !super::title::hermes_same_dir(&session_cwd, cwd)
    {
        return Err("A sessão do Hermes não pertence a esta conversa TUI".into());
    }

    let (message_rows, mut partial) = if let Some(message_id) = message_id {
        let mut statement = conn
            .prepare(
                "SELECT id, role FROM messages WHERE session_id = ?1 AND id = ?2
                   AND role IN ('user', 'assistant')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![session_id, message_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        (rows, false)
    } else {
        let mut statement = conn
            .prepare(
                "SELECT id, role FROM messages
                 WHERE session_id = ?1 AND role IN ('user', 'assistant')
                 ORDER BY id DESC LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query_map(
                rusqlite::params![session_id, (MAX_MESSAGES + 1) as i64],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let partial = rows.len() > MAX_MESSAGES;
        if partial {
            rows.truncate(MAX_MESSAGES);
        }
        (rows, partial)
    };

    let mut turns = Vec::new();
    let mut used_bytes = 0usize;
    // Primeiro se leem só ids e papéis. Para cada corpo, `octet_length(content)` rejeita
    // valores acima do orçamento restante antes de `substr()` ser avaliado. Isso limita a
    // soma dos corpos que o SQLite pode materializar nesta sessão a 4 MiB, mesmo quando a
    // saída indexada de cada fala fica truncada em 16.000 caracteres.
    for (id, role) in message_rows {
        let remaining_bytes = MAX_BYTES.saturating_sub(used_bytes);
        if remaining_bytes == 0 {
            partial = true;
            break;
        }
        let body = match conn
            .query_row(
                "SELECT COALESCE(octet_length(content), 0),
                        substr(COALESCE(content, ''), 1, ?4)
                 FROM messages
                 WHERE session_id = ?1 AND id = ?2 AND role IN ('user', 'assistant')
                   AND (content IS NULL OR octet_length(content) <= ?3)",
                rusqlite::params![
                    session_id,
                    id,
                    remaining_bytes as i64,
                    (MAX_MESSAGE_CHARS + 1) as i64
                ],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
        {
            Ok(Some(body)) => body,
            Ok(None) => {
                if message_id.is_some() {
                    return Err(
                        "A fala do Hermes excede o limite seguro de leitura para busca".into(),
                    );
                }
                // Corpo maior que o orçamento restante (ou removido durante a leitura).
                partial = true;
                continue;
            }
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::TooBig =>
            {
                if message_id.is_some() {
                    return Err(
                        "A fala do Hermes excede o limite seguro de leitura para busca".into(),
                    );
                }
                // Uma mensagem acima do teto não impede indexar as demais falas da sessão.
                partial = true;
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        if message_id.is_none() {
            used_bytes = used_bytes.saturating_add(usize::try_from(body.0).unwrap_or(usize::MAX));
        }
        let raw = body.1;
        let loaded_chars = raw.chars().count();
        let raw_truncated = loaded_chars > MAX_MESSAGE_CHARS || body.0 as usize > raw.len();
        if message_id.is_none() && raw_truncated {
            partial = true;
        }
        let raw: String = raw.chars().take(MAX_MESSAGE_CHARS).collect();
        let Some(text) = hermes_search_text(&raw, raw_truncated) else {
            if raw_truncated {
                partial = true;
            }
            continue;
        };
        if is_hermes_injected_text(&text) {
            continue;
        }
        if !text.trim().is_empty() {
            turns.push(Turn {
                role,
                text,
                source_index: Some(id),
                source_id: None,
                truncated: raw_truncated,
            });
        }
    }
    if message_id.is_none() {
        turns.reverse();
    }
    Ok((turns, partial))
}

fn hermes_search_text(raw: &str, truncated: bool) -> Option<String> {
    let trimmed = raw.trim();
    if let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(trimmed) {
        return text_of_content(&Value::Array(parts));
    }
    if truncated && trimmed.starts_with('[') {
        // Não interpretar JSON cortado como texto evita indexar fragmentos multimodais.
        return None;
    }
    let text = raw.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn is_hermes_injected_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    is_injected_context(text)
        || super::title::is_ade_notice(text)
        || trimmed.starts_with("This session is being continued")
        || trimmed.starts_with("Caveat:")
        || trimmed.starts_with("[Request interrupted")
}

fn parse_transcript(content: &str) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(role) = role_of(&v) else { continue };
        if role != "user" && role != "assistant" {
            continue;
        }
        let Some(text) = content_of(&v) else { continue };
        if is_injected_context(&text) {
            continue;
        }

        // Los CLIs que emiten el mensaje en trozos (streaming) generan varias líneas con
        // el mismo rol; se concatenan en un solo turno en vez de repetir el encabezado.
        match turns.last_mut() {
            Some(last) if last.role == role => {
                last.text.push_str("\n\n");
                last.text.push_str(&text);
            }
            _ => turns.push(Turn {
                role,
                text,
                source_index: None,
                source_id: None,
                truncated: false,
            }),
        }
    }
    turns
}

/// Transcripción de una sesión de OpenCode, pedida a su propia CLI.
///
/// OpenCode no deja un archivo de sesión legible como el resto de los agentes, así que no
/// hay nada que pasarle a `extract_transcript`. Lo que sí tiene es `opencode export <id>`,
/// que escribe la sesión entera como JSON en stdout (el banner informativo va a stderr).
///
/// Formato de export: `info` contém a sessão (`id`, `directory`) e cada `messages[].info`
/// contém `id` e `role`; as partes ficam em `messages[].parts[]`. Só interessam partes do
/// tipo `text`; as demais (`step-start`, `reasoning`, `tool`, `patch`) são etapas internas.
pub(super) fn opencode_transcript(session_id: &str, profile: Option<&str>) -> Vec<Turn> {
    let (program, env_var) = super::title::opencode_invocation();
    let mut command = crate::util::program(program);
    command.args(["export", session_id]).stdin(std::process::Stdio::null());
    // Misma variable con la que se lanzó la tab (ver `accounts`): la sesión de una cuenta
    // alternativa no existe para la instalación del sistema.
    if let Some(dir) = profile {
        command.env(env_var, dir);
    }
    let Ok(output) =
        crate::util::output_with_timeout(&mut command, std::time::Duration::from_secs(30))
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_opencode_export(&output.stdout)
}

/// Parseo puro del JSON que emite `opencode export`, separado del proceso para poder
/// testearlo contra una muestra real sin depender de que OpenCode esté instalado.
pub(super) fn parse_opencode_export(json: &[u8]) -> Vec<Turn> {
    let Ok(root) = serde_json::from_slice::<Value>(json) else {
        return Vec::new();
    };
    parse_opencode_export_value(&root, false, false)
}

fn parse_opencode_export_value(
    root: &Value,
    filter_injected: bool,
    preserve_message_ids: bool,
) -> Vec<Turn> {
    let Some(messages) = root.get("messages").and_then(|m| m.as_array()) else {
        return Vec::new();
    };

    let mut turns: Vec<Turn> = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        let Some(role) = dig(message, &["info", "role"]).and_then(|r| r.as_str()) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = message
            .get("parts")
            .and_then(|p| p.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .filter(|t| !t.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        if filter_injected
            && (is_injected_context(&text)
                || super::title::is_ade_notice(&text)
                || text
                    .trim_start()
                    .starts_with("This session is being continued"))
        {
            continue;
        }

        let source_id = dig(message, &["info", "id"])
            .and_then(Value::as_str)
            .map(str::to_string);
        if preserve_message_ids {
            turns.push(Turn {
                role: role.to_string(),
                text,
                source_index: Some(message_index as i64),
                source_id,
                truncated: false,
            });
            continue;
        }

        // Un turno del asistente puede venir partido en varios mensajes (un "step" por
        // llamada a herramienta); se juntan igual que en `extract_transcript`.
        match turns.last_mut() {
            Some(last) if last.role == role => {
                last.text.push_str("\n\n");
                last.text.push_str(&text);
            }
            _ => turns.push(Turn {
                role: role.to_string(),
                text,
                source_index: Some(message_index as i64),
                source_id,
                truncated: false,
            }),
        }
    }
    turns
}

/// Lê o export OpenCode de um histórico fechado para a busca local. O ID é passado como um
/// argumento literal, o perfil é o mesmo da sessão original, stdout tem teto rígido e o
/// parser precisa reconhecer o envelope antes de classificar uma resposta válida como vazia.
pub(crate) fn opencode_transcript_for_search(
    session_id: &str,
    profile: Option<&Path>,
    cwd: &str,
) -> Result<(Vec<Turn>, bool), String> {
    const MAX_ID_BYTES: usize = 128;
    const MAX_STDOUT_BYTES: usize = 4 * 1024 * 1024;
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    if session_id.len() > MAX_ID_BYTES
        || !session_id.starts_with("ses_")
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("O ID da sessão OpenCode não tem o formato esperado".into());
    }

    let (program, env_var) = super::title::opencode_invocation();
    let mut command = crate::util::program(program);
    command.args(["export", session_id]).stdin(std::process::Stdio::null());
    if let Some(dir) = profile {
        command.env(env_var, dir);
    }
    let output = crate::util::spawn::output_with_stdout_limit(&mut command, TIMEOUT, MAX_STDOUT_BYTES)
        .map_err(|error| format!("Não foi possível exportar a sessão OpenCode: {error}"))?;
    if !output.status.success() {
        return Err("O OpenCode não conseguiu exportar esta sessão".into());
    }

    let turns = parse_opencode_export_for_search(&output.stdout, session_id, cwd)?;
    Ok(limit_opencode_search_corpus(turns, 2 * 1024 * 1024))
}

/// Reutiliza o parser de export da ADE, exigindo a identidade completa do envelope e de cada
/// mensagem conversacional. IDs estáveis permitem reabrir exatamente a fala após retomar a
/// sessão; JSON/envelope incompleto fica indisponível para entrar em cooldown.
pub(crate) fn parse_opencode_export_for_search(
    json: &[u8],
    expected_session_id: &str,
    expected_cwd: &str,
) -> Result<Vec<Turn>, String> {
    let root: Value = serde_json::from_slice(json)
        .map_err(|_| "O export OpenCode não contém JSON válido".to_string())?;
    let info = root
        .get("info")
        .and_then(Value::as_object)
        .ok_or_else(|| "O export OpenCode não contém os metadados da sessão".to_string())?;
    let exported_id = info
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "O export OpenCode não contém um ID de sessão válido".to_string())?;
    if exported_id != expected_session_id {
        return Err("O export OpenCode devolveu outro ID de sessão".into());
    }
    let exported_directory = info
        .get("directory")
        .and_then(Value::as_str)
        .ok_or_else(|| "O export OpenCode não contém um diretório de sessão válido".to_string())?;
    if !same_export_directory(exported_directory, expected_cwd) {
        return Err("O export OpenCode pertence a outra pasta de trabalho".into());
    }
    let messages = root
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "O export OpenCode não contém a lista de mensagens esperada".to_string())?;
    let mut message_ids = std::collections::HashSet::new();
    for message in messages {
        let Some(role) = dig(message, &["info", "role"]).and_then(Value::as_str) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let message_id = dig(message, &["info", "id"])
            .and_then(Value::as_str)
            .filter(|id| id.starts_with("msg") && id.len() <= 128)
            .ok_or_else(|| "O export OpenCode contém uma mensagem sem ID estável".to_string())?;
        if !message_ids.insert(message_id) {
            return Err("O export OpenCode contém IDs de mensagem duplicados".into());
        }
    }
    Ok(parse_opencode_export_value(&root, true, true))
}

fn same_export_directory(exported: &str, expected: &str) -> bool {
    let exported = Path::new(exported);
    let expected = Path::new(expected);
    if !exported.is_absolute() || !expected.is_absolute() {
        return false;
    }
    match (exported.canonicalize(), expected.canonicalize()) {
        (Ok(exported), Ok(expected)) => exported == expected,
        _ => exported == expected,
    }
}

fn limit_opencode_search_corpus(mut turns: Vec<Turn>, max_bytes: usize) -> (Vec<Turn>, bool) {
    let mut retained = Vec::new();
    let mut remaining = max_bytes;
    let mut partial = false;
    for mut turn in turns.drain(..).rev() {
        if remaining == 0 {
            partial = true;
            break;
        }
        if turn.text.len() > remaining {
            let end = turn
                .text
                .char_indices()
                .take_while(|(index, character)| index.saturating_add(character.len_utf8()) <= remaining)
                .map(|(index, character)| index + character.len_utf8())
                .last()
                .unwrap_or(0);
            turn.text.truncate(end);
            turn.truncated = true;
            partial = true;
            remaining = 0;
        } else {
            remaining -= turn.text.len();
        }
        retained.push(turn);
    }
    retained.reverse();
    (retained, partial)
}

pub(super) fn format_ts(unix_seconds: i64) -> String {
    // Sin dependencia de fechas en el backend: se emite ISO-8601 en UTC a mano, que es
    // inequívoco y ordenable. La UI ya muestra la fecha localizada por su cuenta.
    let days_since_epoch = unix_seconds.div_euclid(86_400);
    let secs_of_day = unix_seconds.rem_euclid(86_400);

    // Algoritmo civil-from-days (Howard Hinnant), válido para todo el rango proléptico.
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

pub(super) fn render_skills(skills: &[ArchivedSkill]) -> String {
    if skills.is_empty() {
        return "_Ninguna_".to_string();
    }
    skills
        .iter()
        .map(|s| format!("`{}` ({})", s.name, s.scope))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(super) fn render_siblings(siblings: &[SiblingTab]) -> String {
    if siblings.is_empty() {
        return "_Era la única tab abierta_\n".to_string();
    }
    let mut out = String::new();
    for s in siblings {
        let _ = writeln!(
            out,
            "- {} — `{}` en `{}`",
            s.title.as_deref().unwrap_or("(sin título)"),
            s.agent_label,
            s.cwd
        );
    }
    out
}

pub(super) fn render(entry: &SessionHistoryEntry, workspace: Option<&str>, transcript: &[Turn]) -> String {
    let mut out = String::new();

    let _ = writeln!(out, "# {}", entry.title.as_deref().unwrap_or(&entry.agent_label));
    let _ = writeln!(out);
    let _ = writeln!(out, "| | |");
    let _ = writeln!(out, "|---|---|");
    let _ = writeln!(out, "| Agente | {} (`{}`) |", entry.agent_label, entry.command);
    let _ = writeln!(out, "| Carpeta | `{}` |", entry.cwd);
    if let Some(ws) = workspace {
        let _ = writeln!(out, "| Workspace | {ws} |");
    }
    let _ = writeln!(out, "| Abierta | {} |", format_ts(entry.opened_at));
    let _ = writeln!(out, "| Cerrada | {} |", format_ts(entry.closed_at));
    if let Some(sid) = &entry.session_id {
        let _ = writeln!(out, "| Id de sesión | `{sid}` |");
    }
    let _ = writeln!(out, "| Skills | {} |", render_skills(&entry.skills));
    let _ = writeln!(out);

    let _ = writeln!(out, "## Tabs abiertas junto a esta");
    let _ = writeln!(out);
    let _ = write!(out, "{}", render_siblings(&entry.sibling_tabs));
    let _ = writeln!(out);

    let _ = writeln!(out, "## Conversación");
    let _ = writeln!(out);
    if transcript.is_empty() {
        let _ = writeln!(
            out,
            "_No se pudo leer la conversación de esta sesión: puede que el agente no haya \
             dejado un archivo de sesión legible, o que ya lo haya borrado._"
        );
    } else {
        for turn in transcript {
            let who = if turn.role == "user" { "Usuario" } else { &entry.agent_label };
            let _ = writeln!(out, "### {who}");
            let _ = writeln!(out);
            let _ = writeln!(out, "{}", turn.text);
            let _ = writeln!(out);
        }
    }

    out
}

/// Genera el markdown de una sesión archivada. Se expone aparte de `export_session_markdown`
/// para poder previsualizarlo sin escribir a disco.
#[tauri::command]
pub fn session_markdown(
    history_id: String,
    db: tauri::State<DbConnection>,
) -> Result<String, String> {
    let (entry, workspace) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let entry = crate::database::session_history_entry(&conn, &history_id)?
            .ok_or_else(|| "Esta sesión ya no está en el historial".to_string())?;
        let workspace = crate::database::workspace_name(&conn, &entry.workspace_id);
        (entry, workspace)
    };

    // El lock se suelta antes de tocar el filesystem: buscar y leer el archivo de sesión
    // puede recorrer un árbol grande, y no hay motivo para bloquear la DB mientras tanto.
    //
    // OpenCode va por otro camino porque no deja un archivo de sesión que se pueda leer: su
    // transcripción se pide con `opencode export <id>` (ver `opencode_transcript`). Sin
    // `session_id` no hay nada que exportar — a diferencia del resto, acá no existe un
    // "archivo más reciente del cwd" al que caer.
    // Si la sesión corrió con una cuenta alternativa, su transcript vive dentro de la
    // carpeta de esa cuenta (ver `accounts`) — buscarlo en la del sistema no encontraría
    // nada y el export saldría sin conversación.
    let profile = entry
        .account_id
        .as_deref()
        .and_then(|id| crate::accounts::dir_for(&db, id));
    // OpenCode no deja archivo: su estrategia es preguntarle al proceso. El JSON que vuelve
    // lo entiende `opencode_transcript`, que sigue siendo el parser de ese CLI. Otro
    // provider con `ProcessQuery` necesitaría su propio parser; hoy no hay un segundo.
    let asks_the_process = crate::agents::adapter_for(&entry.agent_id)
        .is_some_and(|adapter| adapter.def().sessions == crate::agents::SessionSource::ProcessQuery);
    let transcript = if asks_the_process {
        entry
            .session_id
            .as_deref()
            .map(|id| opencode_transcript(id, profile.as_deref()))
            .unwrap_or_default()
    } else {
        super::title::session_file_for(
            &entry.agent_id,
            &entry.cwd,
            entry.session_id.as_deref(),
            profile.as_deref().map(std::path::Path::new),
            &db,
        )
        .map(|path| extract_transcript(&path))
        .unwrap_or_default()
    };

    Ok(render(&entry, workspace.as_deref(), &transcript))
}

#[tauri::command]
pub fn export_session_markdown(
    history_id: String,
    dest_path: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let markdown = session_markdown(history_id, db)?;
    std::fs::write(&dest_path, markdown).map_err(|e| e.to_string())
}
