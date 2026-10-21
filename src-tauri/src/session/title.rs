use serde::Serialize;
use crate::agents::SessionSource;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
pub struct SessionTitleResult {
    pub title: String,
    pub source: String,
}

pub(super) fn fallback_result(fallback: &str) -> SessionTitleResult {
    SessionTitleResult { title: fallback.to_string(), source: "fallback".to_string() }
}

pub(super) fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(max).collect::<String>().trim())
    }
}

/// Quando o arquivo NASCEU (segundos), ou, se o sistema de arquivos não informa, quando foi modificado pela última vez.
///
/// O piso temporal da descoberta é "isto não pode ser a sessão desta aba porque já existia quando ela abriu". Com o `mtime` esse
/// piso não separava nada: toda conversa que já existia e continuava sendo escrita (uma feita fora do app, no mesmo projeto, ou de
/// outra aba) tinha `mtime` recente e passava. O nascimento sim: uma conversa antiga nasceu antes de a aba abrir.
pub(super) fn birth_secs(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let born = meta.created().or_else(|_| meta.modified()).ok()?;
    Some(born.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}

std::thread_local! {
    /// Ids de sessão que a descoberta em curso NÃO pode devolver: já são de outras abas abertas.
    static EXCLUDED_SESSION_IDS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Enquanto vive, [`is_excluded`] responde por estes ids (só nesta thread). A descoberta o cria e ele se desfaz sozinho.
pub(super) struct ExcludeGuard;

impl ExcludeGuard {
    pub(super) fn set(ids: &[String]) -> Self {
        EXCLUDED_SESSION_IDS.with(|cell| *cell.borrow_mut() = ids.to_vec());
        ExcludeGuard
    }
}

impl Drop for ExcludeGuard {
    fn drop(&mut self) {
        EXCLUDED_SESSION_IDS.with(|cell| cell.borrow_mut().clear());
    }
}

/// Esta sessão já é de outra aba? Dois agentes iguais na mesma pasta é o caso comum: sem isto, a segunda aba adotava a conversa
/// da primeira.
pub(super) fn is_excluded(id: &str) -> bool {
    EXCLUDED_SESSION_IDS.with(|cell| cell.borrow().iter().any(|taken| taken == id))
}

pub(super) fn mtime_secs(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}

pub(super) fn collect_files(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, ext, out);
        } else if path.extension().is_some_and(|e| e == ext) {
            out.push(path);
        }
    }
}

pub(super) fn newest_matching(
    candidates: &[PathBuf],
    after: Option<i64>,
    content_hint: Option<&str>,
) -> Option<PathBuf> {
    let mut scored: Vec<(PathBuf, i64, bool)> = candidates
        .iter()
        .filter_map(|p| {
            let mtime = mtime_secs(p)?;
            if let Some(after) = after {
                // ">=" y no ">": el timestamp tiene resolución de 1s, así que un archivo
                // creado en el mismo segundo en que arrancó el proceso es válido. Con piso, vale el NACIMENTO (ver `birth_secs`).
                if birth_secs(p)? < after {
                    return None;
                }
            }
            let matches_hint = content_hint
                .map(|hint| fs::read_to_string(p).is_ok_and(|c| c.contains(hint)))
                .unwrap_or(false);
            Some((p.clone(), mtime, matches_hint))
        })
        .collect();

    if scored.is_empty() {
        return None;
    }

    if content_hint.is_some() && scored.iter().any(|(_, _, m)| *m) {
        scored.retain(|(_, _, m)| *m);
    }

    if after.is_some() {
        // Com piso, a aba procura a sessão que NASCEU depois de abrir: a primeira a aparecer é a dela, e uma conversa de fora que
        // nasceu depois é a mais nova, não a dela.
        scored.sort_by_key(|(p, mtime, _)| (birth_secs(p).unwrap_or(i64::MAX), std::cmp::Reverse(*mtime)));
        return scored.into_iter().next().map(|(p, _, _)| p);
    }
    scored.sort_by_key(|(_, mtime, _)| *mtime);
    scored.pop().map(|(p, _, _)| p)
}

/// Primera línea de un archivo, parseada como JSON.
///
/// Existe para no tener que leer el archivo entero cuando lo único que interesa es la
/// cabecera: los rollouts de Codex arrancan con una línea `session_meta` que ya trae el id
/// y el cwd de la sesión, y esos archivos crecen con la conversación entera (tool calls,
/// diffs, salidas de comandos). `read_to_string` sobre TODOS los rollouts del sistema, en
/// cada intento de descubrimiento, es justamente el I/O que hay que evitar.
pub(super) fn first_line_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

/// El más nuevo (por mtime) de los candidatos que pasen `keep`, respetando el piso `after`.
///
/// Variante de `newest_matching` para los agentes cuyo filtro NO es "el cwd aparece en
/// algún lado del archivo" sino una condición que se puede decidir leyendo solo metadata.
pub(super) fn newest_where(
    candidates: &[PathBuf],
    after: Option<i64>,
    keep: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let mut found: Vec<(PathBuf, i64, i64)> = candidates
        .iter()
        .filter_map(|p| {
            let mtime = mtime_secs(p)?;
            let born = birth_secs(p)?;
            // ">=" y no ">" por el mismo motivo que en `newest_matching`: el archivo puede nacer en el mismo segundo del
            // arranque. Con piso, vale el nascimento, não o `mtime` (ver `birth_secs`).
            if after.is_some_and(|a| born < a) {
                return None;
            }
            keep(p).then(|| (p.clone(), mtime, born))
        })
        .collect();
    if after.is_some() {
        // Com piso, a mais antiga das que nasceram depois de a aba abrir (ver `newest_matching`).
        found.sort_by_key(|(_, mtime, born)| (*born, std::cmp::Reverse(*mtime)));
        return found.into_iter().next().map(|(p, _, _)| p);
    }
    found.into_iter().max_by_key(|(_, mtime, _)| *mtime).map(|(p, _, _)| p)
}

pub(super) fn find_string_field(path: &Path, candidates: &[&str]) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        for c in candidates {
            if let Some(s) = v.get(*c).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            if let Some(s) = v.get("payload").and_then(|p| p.get(*c)).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            if let Some(s) = v.get("$set").and_then(|p| p.get(*c)).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Texto de un `content`, que cada CLI modela distinto: string plano, un bloque suelto o
/// una lista. Los bloques de Claude/Codex vienen tipados (`text`/`input_text`/`output_text`);
/// los `Part` de Gemini NO tienen `type`, solo `text` — sin contemplarlos, el título de una
/// sesión de Gemini nunca sale del primer mensaje.
pub(super) fn extract_text_block(content: &Value) -> Option<String> {
    fn text_of_block(b: &Value) -> Option<String> {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") | Some("input_text") | Some("output_text") => {
                b.get("text").and_then(|t| t.as_str()).map(String::from)
            }
            // Bloque tipado de otra cosa (tool_use, thought…): no es texto de la conversación.
            Some(_) => None,
            // Sin `type`: es un Part de Gemini, donde `text` es el contenido.
            None => b.get("text").and_then(|t| t.as_str()).map(String::from),
        }
    }

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    match content.as_array() {
        Some(blocks) => blocks.iter().find_map(text_of_block),
        None => text_of_block(content),
    }
}

// ── Mensajes que no son lo que escribió la persona ──────────────────────
//
// Las TUIs anteponen envoltorios a los mensajes del usuario (caveats de comandos locales,
// contexto de IDE, recordatorios del sistema) y el contenido pegado llega como
// `<pasted_content id="…">…</pasted_content>`. Como título eso sale como XML entero o como
// ruido, así que se saltean y se busca el primer mensaje que sí sea texto.

/// Tags de envoltorio que las TUIs inyectan dentro del mensaje del usuario.
const NOISE_TAGS: &[&str] = &[
    "local-command-caveat",
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "system-reminder",
    "browser_instruction",
    "ide_opened_file",
    "ide_selection",
];

/// Cuántos mensajes del usuario se miran, como mucho, buscando uno que sirva de título.
const TITLE_SCAN_LIMIT: usize = 30;

/// Um aviso que o próprio ADE colou na conversa (`[ADE AGS] NAVEGADOR: …`, `[ADE AGS] Você é um subagente…`, o
/// `[AGS] …` das missões). Chega como mensagem do usuário, mas não é o assunto da conversa: abrindo um agente, era
/// a primeira mensagem e virava o título.
pub(super) fn is_ade_notice(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("[ADE AGS]") || t.starts_with("[AGS]")
}

/// Um título que a TUI gerou SOZINHA a partir de um aviso do ADE (o Claude e o OpenCode resumem a primeira
/// mensagem: "Navegador ags portal no canvas"). Só frases que saem dos avisos, não o nome do app — quem trabalha
/// no próprio ADE AGS escreve "ADE AGS" no título de verdade.
pub(super) fn echoes_ade_notice(title: &str) -> bool {
    let t = title.to_lowercase();
    is_ade_notice(title)
        || ["ags portal", "navegador ags", "subagente deste time", "orquestrador deste canvas", "[ade ags]"]
            .iter()
            .any(|marker| t.contains(marker))
}

/// `true` si el mensaje es un envoltorio del sistema y no algo que escribió la persona.
/// `<pasted_content` también cuenta: `clean_message` lo desenvuelve antes de decidir.
pub(super) fn is_noise_message(text: &str) -> bool {
    let t = text.trim();
    if t.starts_with("This session is being continued")
        || t.starts_with("Caveat:")
        || t.starts_with("[Request interrupted")
        || t.starts_with("<pasted_content")
        || is_ade_notice(t)
    {
        return true;
    }
    let Some(rest) = t.strip_prefix('<') else { return false };
    let tag = rest
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .next()
        .unwrap_or("");
    NOISE_TAGS.contains(&tag)
}

/// Lo que puede servir de título de un mensaje del usuario, o `None` si es ruido o está
/// vacío. Desenvuelve `<pasted_content …>` (queda el texto de adentro) y devuelve la
/// primera línea con contenido.
pub(super) fn clean_message(text: &str) -> Option<String> {
    let mut body = text.trim();
    if body.starts_with("<pasted_content") {
        if let Some(end) = body.find('>') {
            body = &body[end + 1..];
        }
        body = body.trim_end().strip_suffix("</pasted_content>").unwrap_or(body);
    }
    let body = body.trim();
    if is_noise_message(body) {
        return None;
    }
    let line = body.lines().map(str::trim).find(|l| !l.is_empty())?;
    if is_noise_message(line) {
        return None;
    }
    Some(line.to_string())
}

/// Un título que NO conviene mostrar: vacío, XML/envoltorio, el placeholder
/// `<agente> — <carpeta/ruta>` o simplemente el nombre del agente. Sirve para decidir si
/// una sesión ya guardada merece recalcularse.
pub fn is_weak_title(title: &str, agent_label: &str) -> bool {
    let t = title.trim();
    if t.is_empty() || t.starts_with('<') || is_noise_message(t) || echoes_ade_notice(t) {
        return true;
    }
    if t == agent_label.trim() {
        return true;
    }
    if let Some((_, rest)) = t.split_once(" — ") {
        let rest = rest.trim_start();
        let b = rest.as_bytes();
        let is_drive = b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/');
        if rest.starts_with('/') || rest.starts_with('\\') || is_drive {
            return true;
        }
    }
    false
}

// ── Claude Code: ~/.claude/projects/<cwd con '/' -> '-'>/<uuid>.jsonl ────

/// Nombre de carpeta que Claude Code le da a un proyecto.
///
/// **Reemplaza TODO lo que no sea alfanumérico por `-`, no solo las barras.** Derivado
/// contra las carpetas reales de una instalación con proyectos de nombres variados: la
/// regla acierta 8 de 8, mientras que reemplazar solo `/` fallaba en los 3 proyectos cuya
/// ruta tiene un espacio.
///
/// Ese era un bug silencioso y caro: para cualquier proyecto en una ruta con espacios (o
/// puntos, o cualquier otro carácter especial) se buscaba en una carpeta que no existe, así
/// que la sesión nunca se descubría. Esas tabs quedaban sin id de sesión —sin título real,
/// sin reanudar al reabrirlas y sin poder actualizar su entrada del historial— y desde
/// afuera se veía como "la app no guarda las sesiones".
pub(super) fn claude_project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// `profile` es el directorio de la cuenta con la que corre la tab (`CLAUDE_CONFIG_DIR`).
/// Con una cuenta alternativa, TODO lo de Claude Code vive ahí adentro — incluidos los
/// transcripts — así que buscar en `~/.claude` daría siempre "sin sesión": ni título ni
/// resume. `None` = la cuenta del sistema.
pub(super) fn claude_project_dir(cwd: &str, profile: Option<&Path>) -> PathBuf {
    let root = match profile {
        Some(dir) => dir.to_path_buf(),
        None => dirs::home_dir().unwrap_or_default().join(".claude"),
    };
    let projects = root.join("projects");
    let dir = projects.join(claude_project_slug(cwd));
    if dir.exists() {
        return dir;
    }
    // Respaldo para instalaciones viejas de Claude Code, que sí usaban solo las barras.
    // Solo se toma si existe de verdad, así que no puede tapar a la regla buena.
    if let Some(legacy) = claude_legacy_project_dir(&projects, cwd) {
        if legacy.exists() {
            return legacy;
        }
    }
    dir
}

/// Carpeta del respaldo viejo (solo las barras reemplazadas por `-`), o `None` si ese nombre
/// no puede ser UNA carpeta dentro de `projects`.
///
/// `PathBuf::join` con una ruta absoluta descarta la base. En Windows el cwd empieza con
/// `C:\`, así que el "respaldo" quedaba igual al propio proyecto: `claude_session_file` lo
/// recorría entero y tomaba como sesión cualquier `.jsonl` dentro del repo (un fixture de
/// tests apareció como sesión de una tab de Claude Code).
pub(super) fn claude_legacy_project_dir(projects: &Path, cwd: &str) -> Option<PathBuf> {
    let name = cwd.replace('/', "-");
    // La barra invertida es separador en Windows y no en Linux: se rechaza en las dos, así el
    // resultado no depende de dónde corre la app.
    if name.contains('\\') {
        return None;
    }
    let mut parts = Path::new(&name).components();
    let is_one_normal_part = matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    );
    let legacy = projects.join(&name);
    (is_one_normal_part && legacy.starts_with(projects)).then_some(legacy)
}

pub(super) fn claude_session_file(
    cwd: &str,
    session_id: Option<&str>,
    after: Option<i64>,
    profile: Option<&Path>,
) -> Option<PathBuf> {
    let dir = claude_project_dir(cwd, profile);
    if let Some(id) = session_id {
        // Com um id conhecido, só o arquivo desse id. Cair para «o mais novo da pasta» devolvia a conversa de OUTRA pessoa quando a
        // da aba ainda não tinha arquivo (uma aba com o id escolhido pela app, antes da primeira mensagem), e o título e a
        // exportação saíam dela.
        let direct = dir.join(format!("{id}.jsonl"));
        return direct.exists().then_some(direct);
    }
    let mut files = Vec::new();
    collect_files(&dir, "jsonl", &mut files);
    if after.is_some() {
        files.retain(|p| !p.file_stem().is_some_and(|s| is_excluded(&s.to_string_lossy())));
    }
    newest_matching(&files, after, None)
}

/// O que já se leu de um transcript do Claude: até onde (`offset`, sempre no fim de uma linha) e o
/// que se achou. O título é o primeiro `summary` do arquivo, ou a primeira mensagem do usuário; as
/// linhas novas só podem trazer um `summary`, então dá para continuar de onde parou.
#[derive(Clone, Default)]
struct ClaudeScan {
    offset: u64,
    summary: Option<String>,
    first_user: Option<String>,
    users_seen: usize,
}

fn claude_scan_cache() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, ClaudeScan>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, ClaudeScan>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Continua a leitura de `scan` do ponto em que parou. Uma linha sem `\n` no fim (o agente ainda
/// escrevendo) fica para a próxima vez.
fn claude_scan_from(path: &Path, mut scan: ClaudeScan) -> Option<ClaudeScan> {
    use std::io::{Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(scan.offset)).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).ok()?;
        if read == 0 || line.last() != Some(&b'\n') {
            break;
        }
        scan.offset += read as u64;
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) == Some("summary") {
            // Um resumo feito a partir de um aviso do ADE não serve: segue procurando (outro resumo ou a 1ª mensagem).
            if let Some(s) = v.get("summary").and_then(|s| s.as_str()).filter(|s| !echoes_ade_notice(s)) {
                scan.summary = Some(s.to_string());
                break;
            }
        }
        if scan.first_user.is_none()
            && scan.users_seen < TITLE_SCAN_LIMIT
            && v.get("type").and_then(|t| t.as_str()) == Some("user")
        {
            scan.users_seen += 1;
            scan.first_user = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(extract_text_block)
                .and_then(|t| clean_message(&t));
        }
    }
    Some(scan)
}

/// O título de um transcript do Claude. Antes cada chamada lia o arquivo inteiro (`read_to_string`)
/// e a lista de conversas chamava a cada 20 s por aba aberta, relendo transcripts de vários MB (o
/// maior, 143 MB). Agora lê só o que o arquivo cresceu desde a última vez; com `summary` achado,
/// nem abre o arquivo.
pub(super) fn claude_title(path: &Path, fallback: &str) -> SessionTitleResult {
    let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let cached = claude_scan_cache().lock().ok().and_then(|c| c.get(path).cloned());
    let scan = match cached {
        Some(scan) if scan.summary.is_some() && len >= scan.offset => Some(scan),
        // Arquivo menor que o lido: foi reescrito. Recomeça.
        Some(scan) if len >= scan.offset => claude_scan_from(path, scan),
        _ => claude_scan_from(path, ClaudeScan::default()),
    };
    let Some(scan) = scan else { return fallback_result(fallback) };
    if let Ok(mut cache) = claude_scan_cache().lock() {
        cache.insert(path.to_path_buf(), scan.clone());
    }
    if let Some(s) = &scan.summary {
        return SessionTitleResult { title: truncate(s, 60), source: "summary".into() };
    }
    match scan.first_user {
        Some(m) => SessionTitleResult { title: truncate(&m, 60), source: "first_message".into() },
        None => fallback_result(fallback),
    }
}

/// Os títulos de Gemini e Codex, recalculados só quando o arquivo muda (tamanho ou mtime).
fn cached_title(path: &Path, fallback: &str, compute: impl FnOnce() -> SessionTitleResult) -> SessionTitleResult {
    type Key = (u64, Option<std::time::SystemTime>, String);
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, (Key, SessionTitleResult)>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let meta = fs::metadata(path).ok();
    let key: Key = (meta.as_ref().map(|m| m.len()).unwrap_or(0), meta.and_then(|m| m.modified().ok()), fallback.to_string());
    if let Some((k, result)) = cache.lock().ok().and_then(|c| c.get(path).cloned()) {
        if k == key {
            return result;
        }
    }
    let result = compute();
    if let Ok(mut c) = cache.lock() {
        c.insert(path.to_path_buf(), (key, result.clone()));
    }
    result
}

// ── Gemini CLI: ~/.gemini/tmp/<slug>/chats/session-*.jsonl ───────────────
//
// Gemini le asigna a cada proyecto una carpeta bajo `~/.gemini/tmp/`. El nombre NO es un
// hash: es un slug legible del basename del proyecto (`mi-proyecto`, `mi-proyecto-1` si
// choca), asignado por su ProjectRegistry. Como el slug se reparte por orden de llegada,
// no se puede derivar del cwd — hay que consultarlo. Gemini deja DOS formas de hacerlo:
//
//   ~/.gemini/projects.json          {"projects": {"/ruta/abs": "slug"}}
//   ~/.gemini/tmp/<slug>/.project_root   contiene la ruta absoluta del proyecto
//
// Adentro, la conversación vive en `<slug>/chats/session-<YYYY-MM-DDTHH-mm>-<8>.jsonl`,
// cuya PRIMERA línea es la metadata de la sesión:
//
//   {"sessionId":"…","projectHash":"…","startTime":"…","lastUpdated":"…",
//    "kind":"main"|"subagent","summary":"…"}
//
// Antes esto se resolvía escaneando TODO `~/.gemini/tmp` y quedándose con el archivo más
// nuevo que CONTUVIERA el cwd como substring. Eso traía tres problemas, los tres reales:
//
//   1. `contains` da falso positivo por prefijo — una tab de `/home/u/proj` podía quedarse
//      con la sesión de `/home/u/proj2` y reanudar la conversación de otro proyecto.
//   2. Los sub-agentes escriben su propio `.jsonl` en la misma carpeta con
//      `kind: "subagent"`. Al ser el más nuevo, la tab podía adoptar el id de un sub-agente
//      en vez del de la sesión principal, y `--resume` con ese id no reanuda la charla.
//   3. Leía el contenido completo de todos los archivos de sesión del sistema en cada
//      intento de descubrimiento (cada 3s), no solo los de este proyecto.

/// Home de Gemini.
///
/// `GEMINI_CLI_HOME` no apunta al directorio `.gemini`: apunta al padre, y el CLI crea
/// `.gemini` adentro. `Some(dir)` es ese padre (el directorio de una cuenta). `None` es
/// la cuenta del sistema, `~/.gemini`.
///
/// El registro sigue con `profile: None` para Gemini. Esto solo prepara la lectura para
/// cuando una cuenta exista; con `None` el camino no cambia.
pub(super) fn gemini_home(profile: Option<&Path>) -> PathBuf {
    match profile {
        Some(dir) => dir.join(".gemini"),
        None => dirs::home_dir().unwrap_or_default().join(".gemini"),
    }
}

/// Carpeta que Gemini le asignó a este cwd, o `None` si nunca abrió una sesión acá.
pub(super) fn gemini_project_dir(home: &Path, cwd: &str) -> Option<PathBuf> {
    let tmp = home.join("tmp");

    // 1) El registro, que es el mapa autoritativo proyecto → slug.
    if let Ok(raw) = fs::read_to_string(home.join("projects.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(projects) = v.get("projects").and_then(|p| p.as_object()) {
                if let Some(slug) =
                    projects.iter().find(|(k, _)| Path::new(k.as_str()) == Path::new(cwd))
                        .and_then(|(_, v)| v.as_str())
                {
                    let dir = tmp.join(slug);
                    if dir.is_dir() {
                        return Some(dir);
                    }
                }
            }
        }
    }

    // 2) Los marcadores `.project_root`, que Gemini escribe justamente para poder verificar
    //    a qué proyecto pertenece cada slug. Cubre el caso de un registro desincronizado.
    let entries = fs::read_dir(&tmp).ok()?;
    entries.flatten().map(|e| e.path()).find(|dir| {
        fs::read_to_string(dir.join(".project_root"))
            .is_ok_and(|owner| Path::new(owner.trim()) == Path::new(cwd))
    })
}

/// Metadata de la primera línea de un archivo de chat.
pub(super) struct GeminiMeta {
    pub(super) session_id: Option<String>,
    pub(super) kind: Option<String>,
}

pub(super) fn gemini_meta(path: &Path) -> Option<GeminiMeta> {
    let v = first_line_json(path)?;
    // `sessionId` es obligatorio en la cabecera; si no está, esta no es una cabecera.
    let session_id = v.get("sessionId").and_then(|s| s.as_str()).map(String::from)?;
    Some(GeminiMeta {
        session_id: Some(session_id),
        kind: v.get("kind").and_then(|k| k.as_str()).map(String::from),
    })
}

/// Una sesión de sub-agente no es la conversación de la tab: reanudarla con `--resume`
/// no devuelve al usuario a su charla. `kind` ausente se trata como principal, que es el
/// comportamiento de las versiones que todavía no escribían el campo.
pub(super) fn gemini_is_main_session(path: &Path) -> bool {
    match gemini_meta(path) {
        Some(m) => m.kind.as_deref() != Some("subagent"),
        None => false,
    }
}

pub(super) fn gemini_chat_files(home: &Path, cwd: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(dir) = gemini_project_dir(home, cwd) {
        collect_files(&dir.join("chats"), "jsonl", &mut files);
    }
    files
}

pub(super) fn gemini_session_file(cwd: &str, after: Option<i64>, profile: Option<&Path>) -> Option<PathBuf> {
    gemini_session_file_in(&gemini_home(profile), cwd, after)
}

pub(super) fn gemini_session_file_in(home: &Path, cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    let files = gemini_chat_files(home, cwd);
    if !files.is_empty() {
        return newest_where(&files, after, |p| {
            gemini_is_main_session(p)
                && !(after.is_some() && gemini_meta(p).and_then(|m| m.session_id).is_some_and(|id| is_excluded(&id)))
        });
    }

    // No se pudo ubicar la carpeta del proyecto (instalación vieja con carpetas por hash,
    // registro ilegible, permisos). Se degrada al escaneo global de antes en vez de dejar de
    // funcionar — pero con el cwd entre comillas, que dentro de un JSON delimita el valor y
    // evita el falso positivo por prefijo.
    let mut all = Vec::new();
    collect_files(&home.join("tmp"), "jsonl", &mut all);
    newest_matching(&all, after, Some(&format!("\"{cwd}\"")))
}

pub(super) fn gemini_session_file_by_id(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    gemini_chat_files(home, cwd)
        .into_iter()
        .find(|p| gemini_meta(p).and_then(|m| m.session_id).as_deref() == Some(session_id))
}

pub(super) fn gemini_title(path: &Path, fallback: &str) -> SessionTitleResult {
    let Ok(content) = fs::read_to_string(path) else { return fallback_result(fallback) };
    let mut first_user_msg: Option<String> = None;
    let mut user_msgs_seen = 0usize;

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let summary = v.get("summary").and_then(|s| s.as_str())
            .or_else(|| v.get("$set").and_then(|s| s.get("summary")).and_then(|s| s.as_str()))
            .filter(|s| !echoes_ade_notice(s));
        if let Some(s) = summary {
            return SessionTitleResult { title: truncate(s, 60), source: "summary".into() };
        }
        // El contenido es un PartListUnion, no un string: `as_str()` solo cubría el caso
        // más raro (string pelado) y dejaba afuera el habitual, `[{"text": "…"}]`.
        if first_user_msg.is_none()
            && user_msgs_seen < TITLE_SCAN_LIMIT
            && v.get("type").and_then(|t| t.as_str()) == Some("user")
        {
            user_msgs_seen += 1;
            first_user_msg = v
                .get("content")
                .and_then(extract_text_block)
                .and_then(|t| clean_message(&t));
        }
    }

    match first_user_msg {
        Some(m) => SessionTitleResult { title: truncate(&m, 60), source: "first_message".into() },
        None => fallback_result(fallback),
    }
}

// ── Codex: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl ───────────────
//
// Cada rollout es un JSONL cuya PRIMERA línea es la cabecera de la sesión:
//
//   {"timestamp":"…","type":"session_meta",
//    "payload":{"id":"…","cwd":"/ruta","source":"cli","cli_version":"…","git":{…}}}
//
// y las siguientes son `response_item` / `event_msg` / `turn_context` / … con el mismo
// envoltorio `{timestamp, type, payload}`.
//
// Eso hace que el id y el cwd de la sesión se puedan leer SIN abrir el archivo entero,
// que es lo que hacía la versión anterior: filtraba con `newest_matching(.., Some(cwd))`,
// o sea `read_to_string` + `contains(cwd)` sobre TODOS los rollouts del sistema, en cada
// intento de descubrimiento (cada 3s al principio). Con historial acumulado eso es leer
// megabytes de conversaciones para resolver una tab.
//
// Además `contains` daba falsos positivos por prefijo: el cwd `/home/u/proj` está
// contenido en cualquier rollout de `/home/u/proj2`, así que una tab podía adoptar el
// session id de OTRO proyecto y reanudar la conversación equivocada. Comparar `payload.cwd`
// como ruta, y no como substring, elimina las dos cosas.

pub(super) fn codex_root(profile: Option<&Path>) -> PathBuf {
    if let Some(dir) = profile {
        return dir.join("sessions");
    }
    // Codex respeta CODEX_HOME para reubicar toda su configuración y su historial; si no
    // está definida cae en ~/.codex.
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));
    home.join("sessions")
}

/// Cabecera `session_meta` de un rollout: lo que hace falta para identificar la sesión sin
/// leer la conversación. `None` si el archivo no arranca con una cabecera reconocible.
pub(super) struct CodexMeta {
    pub(super) id: Option<String>,
    pub(super) cwd: PathBuf,
}

pub(super) fn codex_meta(path: &Path) -> Option<CodexMeta> {
    let v = first_line_json(path)?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    Some(CodexMeta {
        id: payload.get("id").and_then(|i| i.as_str()).map(String::from),
        cwd: PathBuf::from(payload.get("cwd").and_then(|c| c.as_str())?),
    })
}

pub(super) fn codex_rollouts_in(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_files(root, "jsonl", &mut files);
    files
}

pub(super) fn codex_rollouts(profile: Option<&Path>) -> Vec<PathBuf> {
    codex_rollouts_in(&codex_root(profile))
}

/// Rollout de la sesión con ESTE id exacto. Se prefiere a "el más nuevo del cwd" cuando el
/// id se conoce: con dos tabs de Codex abiertas en la misma carpeta, "el más nuevo" es el de
/// la otra tab y los títulos quedarían cruzados.
pub(super) fn codex_session_file_by_id(session_id: &str, profile: Option<&Path>) -> Option<PathBuf> {
    codex_rollouts(profile)
        .into_iter()
        .find(|p| codex_meta(p).and_then(|m| m.id).as_deref() == Some(session_id))
}

pub(super) fn codex_session_file(cwd: &str, after: Option<i64>, profile: Option<&Path>) -> Option<PathBuf> {
    codex_session_file_in(&codex_root(profile), cwd, after)
}

pub(super) fn codex_session_file_in(root: &Path, cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    let files = codex_rollouts_in(root);
    if let Some(found) = newest_where(&files, after, |p| {
        codex_meta(p).is_some_and(|m| m.cwd == Path::new(cwd) && !(after.is_some() && m.id.as_deref().is_some_and(is_excluded)))
    }) {
        return Some(found);
    }

    // Ningún rollout declaró este cwd en su cabecera. Puede ser que no haya sesión (caso
    // normal, y entonces el fallback tampoco encuentra nada), o que una versión de Codex
    // cambie el formato de la cabecera — en ese caso se degrada al escaneo por contenido
    // de antes en vez de dejar de funcionar del todo.
    //
    // El hint va entre comillas (`"/ruta"`) y no pelado: dentro de un JSON el valor está
    // delimitado, así que exigir las comillas evita el falso positivo por prefijo
    // (`/home/u/proj` contra un rollout de `/home/u/proj2`).
    if !files.is_empty() && files.iter().any(|p| codex_meta(p).is_some()) {
        // Hay cabeceras legibles y ninguna es de este cwd: la respuesta es "no hay sesión",
        // no hace falta el fallback caro.
        return None;
    }
    newest_matching(&files, after, Some(&format!("\"{cwd}\"")))
}

/// Codex arranca toda sesión inyectando contexto sintético como si fuera del usuario
/// (`<environment_context>` con el cwd/OS/sandbox, `<user_instructions>` con el AGENTS.md).
/// Eso no lo escribió la persona: como título de tab sería siempre el mismo bloque de XML,
/// y en el export ensuciaría el arranque de la conversación.
pub(super) fn codex_is_synthetic(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>")
        || t.starts_with("<user_instructions>")
        || t.starts_with("## My environment")
}

pub(super) fn codex_title(path: &Path, fallback: &str) -> SessionTitleResult {
    let Ok(content) = fs::read_to_string(path) else { return fallback_result(fallback) };
    let mut user_msgs_seen = 0usize;

    for line in content.lines() {
        if user_msgs_seen >= TITLE_SCAN_LIMIT {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let msg_type = v.get("type").and_then(|t| t.as_str());

        if msg_type == Some("event_msg") {
            let payload = v.get("payload");
            if payload.and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("user_message") {
                if let Some(m) = payload.and_then(|p| p.get("message")).and_then(|m| m.as_str()) {
                    if !codex_is_synthetic(m) {
                        user_msgs_seen += 1;
                        if let Some(clean) = clean_message(m) {
                            return SessionTitleResult {
                                title: truncate(&clean, 60),
                                source: "first_message".into(),
                            };
                        }
                    }
                }
            }
        }

        // El rol vive en `payload` (el envoltorio de la línea solo trae timestamp/type),
        // pero se acepta también en la raíz: los rollouts viejos guardaban el response_item
        // plano, sin envolver.
        if msg_type == Some("response_item") {
            let body = v.get("payload").unwrap_or(&v);
            if body.get("role").and_then(|r| r.as_str()) == Some("user") {
                if let Some(text) = body.get("content").and_then(extract_text_block) {
                    if !codex_is_synthetic(&text) {
                        user_msgs_seen += 1;
                        if let Some(clean) = clean_message(&text) {
                            return SessionTitleResult {
                                title: truncate(&clean, 60),
                                source: "first_message".into(),
                            };
                        }
                    }
                }
            }
        }
    }

    fallback_result(fallback)
}

// ── OpenCode: vía su propia CLI, no leyendo su almacenamiento ─────────
//
// Los otros agentes se resuelven leyendo los archivos de sesión que dejan en disco. Con
// OpenCode eso no funciona: la implementación anterior asumía
// `~/.local/share/opencode/storage/session/<projectID>/<id>.json` por analogía con Claude
// Code, nunca se verificó, y no encontraba nada — el título automático y el resume de
// OpenCode simplemente no funcionaban.
//
// OpenCode expone `session list --format json`, que es contrato público y documentado
// (opencode.ai/docs/cli), así que se le pregunta a él en vez de espiarle los archivos.
// Verificado contra la v1.18.4 instalada; cada entrada trae exactamente lo que hace falta:
//
//   { "id": "ses_…", "title": "…", "created": 1782913776585,
//     "updated": …, "projectId": "…", "directory": "/ruta/del/proyecto" }
//
// `directory` es lo que permite filtrar por cwd sin tener que resolver el projectId a mano,
// y los timestamps vienen en MILISEGUNDOS (el resto del módulo trabaja en segundos).

/// Ventana de tolerancia al comparar el `created` de una sesión contra el arranque de la
/// tab: OpenCode sella la sesión cuando el usuario manda el primer mensaje, no cuando
/// arranca el proceso, pero un reloj con desfase no debería descartar una sesión legítima.
const OPENCODE_CLOCK_SKEW_S: i64 = 5;

#[derive(serde::Deserialize)]
pub(super) struct OpencodeSession {
    pub(super) id: String,
    #[serde(default)]
    pub(super) title: String,
    #[serde(default)]
    pub(super) directory: String,
    #[serde(default)]
    pub(super) created: i64,
}

/// Sesiones de OpenCode para un cwd, de la más reciente a la más vieja.
///
/// Se acota con `-n` en vez de traer todo el historial: solo interesan las últimas, y cada
/// llamada levanta un proceso que abre la base de datos entera de OpenCode (~0.9 s medido
/// contra la v1.18.4), así que no conviene pedir de más.
///
/// `current_dir` no es cosmético: `opencode session list` está acotado por proyecto según
/// el directorio desde el que corre. Ejecutado desde otro lado devuelve las sesiones de
/// OTRO proyecto — verificado: desde `/tmp` lista las del proyecto `global`, no las de
/// este cwd. El filtro por `directory` de abajo es la segunda red.
///
/// Cada fallo se reporta por stderr en vez de degradar en silencio: sin eso, "no aparece
/// la sesión" es indistinguible de "opencode no está en el PATH del proceso de la app",
/// que es un caso real cuando la app se lanza desde el menú del escritorio y no desde una
/// terminal (el PATH del launcher no incluye `~/.opencode/bin`).
/// Cuánto se espera a `opencode` antes de darlo por colgado. Generoso frente a lo que
/// tarda de verdad (~1s medido) y muy por debajo de lo que un usuario tolera esperando a
/// que cierre una ventana.
const OPENCODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) fn opencode_sessions(cwd: &str, profile: Option<&Path>) -> Vec<OpencodeSession> {
    let (program, env_var) = opencode_invocation();
    let mut command = crate::util::program(program);
    command
        .args(["session", "list", "--format", "json", "-n", "50"])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null());
    // Misma variable con la que se lanzó la tab (ver `accounts`): sin esto, `session list`
    // listaría las sesiones de la cuenta del sistema y el título saldría cruzado.
    if let Some(dir) = profile {
        command.env(env_var, dir);
    }
    // Con plazo: esta función corre en el camino de cerrar una tab, y un `opencode`
    // colgado no puede dejar a la app esperándolo para siempre.
    let output = match crate::util::output_with_timeout(&mut command, OPENCODE_TIMEOUT) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[opencode] no se pudo ejecutar `opencode session list`: {e}");
            return Vec::new();
        }
    };
    if !output.status.success() {
        eprintln!(
            "[opencode] `session list` salió con {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return Vec::new();
    }

    // El banner informativo de OpenCode va a stderr, así que stdout es JSON puro.
    let mut sessions: Vec<OpencodeSession> = match serde_json::from_slice(&output.stdout) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[opencode] salida de `session list` ilegible: {e}");
            return Vec::new();
        }
    };

    let total = sessions.len();
    sessions.retain(|s| Path::new(&s.directory) == Path::new(cwd));
    if sessions.is_empty() && total > 0 {
        eprintln!(
            "[opencode] {total} sesión(es) devueltas pero ninguna con directory == {cwd}"
        );
    }
    sessions.sort_by(|a, b| b.created.cmp(&a.created));
    sessions
}

/// Sesión más reciente del cwd, opcionalmente creada después de `after` (en segundos).
pub(super) fn opencode_session(cwd: &str, after: Option<i64>, profile: Option<&Path>) -> Option<OpencodeSession> {
    let sessions = opencode_sessions(cwd, profile);
    let mut candidates = sessions.into_iter().filter(|s| match after {
        // `created` viene en MILISEGUNDOS; el resto del módulo trabaja en segundos.
        Some(t) => s.created / 1000 >= t - OPENCODE_CLOCK_SKEW_S && !is_excluded(&s.id),
        None => true,
    });
    // `opencode_sessions` ordena da mais nova para a mais velha. Com piso, a aba procura a que nasceu logo depois de abrir (a mais
    // velha das candidatas); sem piso, a mais recente do cwd.
    let found = if after.is_some() { candidates.last() } else { candidates.next() };
    if found.is_none() {
        if let Some(t) = after {
            eprintln!("[opencode] ninguna sesión de {cwd} creada después de {t}");
        }
    }
    found
}

/// OpenCode nombra las sesiones `New session - <ISO>` hasta que el modelo les pone un
/// título real. Ese placeholder no le dice nada al usuario en la barra de tabs, así que se
/// trata como "todavía no hay título" y se deja el fallback (el comando se reintenta más
/// adelante y para entonces suele estar el bueno).
pub(super) fn opencode_is_placeholder_title(title: &str) -> bool {
    title.trim_start().starts_with("New session -")
}

// ── Kimi Code: $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/ ────────
//
// Kimi ya figuraba como agente detectable y con comando de resume (`--session <id>`), pero
// NO tenía implementación de sesiones: caía en la rama `other`, que busca el agente en la
// tabla de TUIs custom, no lo encontraba (es de fábrica, no custom) y devolvía `None`.
// O sea que el id nunca se descubría, el título nunca salía y el resume nunca se armaba:
// el soporte era nominal.
//
// Layout documentado (kimi.com/code/docs → Data locations):
//
//   sessions/<workDirKey>/<sessionId>/state.json            ← metadata (title, lastPrompt…)
//   sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl ← stream del agente principal
//
// `workDirKey` es `wd_<slug>_<primeros-12-de-sha256>`, pero la doc NO especifica qué string
// exacto se hashea ni cómo se arma el slug. Reconstruirlo a ojo sería adivinar, y adivinar
// mal significa no encontrar NINGUNA sesión — así que no se reconstruye: se recorren los
// buckets y se identifica la sesión por su propia metadata. El id es el nombre de la
// carpeta, que sí es contrato observable.
const KIMI_CWD_FIELDS: &[&str] =
    &["workDir", "workingDirectory", "cwd", "directory", "projectRoot", "work_dir", "root"];

/// Raíz `sessions/` de Kimi.
///
/// `Some(dir)` es el home de esa cuenta: las sesiones viven en `<dir>/sessions`, igual
/// que bajo `KIMI_CODE_HOME`. `None` conserva la cuenta del sistema (`KIMI_CODE_HOME` o
/// `~/.kimi-code`). Kimi sigue sin `profile` en el registro: no se inventó una variable.
pub(super) fn kimi_root(profile: Option<&Path>) -> PathBuf {
    let home = match profile {
        Some(dir) => dir.to_path_buf(),
        None => std::env::var_os("KIMI_CODE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".kimi-code")),
    };
    home.join("sessions")
}

/// Carpetas de sesión: los nietos de `sessions/` que tengan un `state.json`.
/// Se camina en dos niveles exactos en vez de recursivamente porque adentro de cada sesión
/// hay muchos más `.json` (`upcoming-goals.json`, `agents/*/plans/*`) que no son sesiones.
pub(super) fn kimi_session_dirs(profile: Option<&Path>) -> Vec<PathBuf> {
    kimi_session_dirs_in(&kimi_root(profile))
}

pub(super) fn kimi_session_dirs_in(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Ok(buckets) = fs::read_dir(root) else { return dirs };
    for bucket in buckets.flatten() {
        let Ok(sessions) = fs::read_dir(bucket.path()) else { continue };
        for session in sessions.flatten() {
            let dir = session.path();
            if dir.join("state.json").is_file() {
                dirs.push(dir);
            }
        }
    }
    dirs
}

pub(super) fn kimi_state(dir: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(dir.join("state.json")).ok()?).ok()
}

/// El id de la sesión es el nombre de su carpeta — que es lo que espera `kimi --session`.
pub(super) fn kimi_session_id(dir: &Path) -> Option<String> {
    dir.file_name().map(|s| s.to_string_lossy().to_string())
}

/// Directorio de trabajo declarado en `state.json`, si lo declara.
///
/// La doc lista los campos de `state.json` como "title, lastPrompt, timestamps, forkedFrom"
/// sin enumerarlos todos, así que no está garantizado que el cwd esté ahí. Devolver `None`
/// cuando no aparece es deliberado: el llamador entonces NO filtra por cwd en vez de
/// filtrar con un criterio inventado y quedarse sin resultados.
pub(super) fn kimi_declared_cwd(state: &Value) -> Option<PathBuf> {
    KIMI_CWD_FIELDS
        .iter()
        .find_map(|k| state.get(*k).and_then(|v| v.as_str()))
        .map(PathBuf::from)
}

/// Sesión más reciente, filtrando por cwd solo si `state.json` lo declara.
///
/// El orden es por mtime del `state.json` (se reescribe en cada turno). Cuando el cwd no se
/// puede confirmar, el piso `after` — el arranque de ESTA tab — es lo único que separa esta
/// sesión de la de otra tab, igual que con las TUIs custom.
pub(super) fn kimi_session_dir(cwd: Option<&str>, after: Option<i64>, profile: Option<&Path>) -> Option<PathBuf> {
    kimi_session_dir_in(&kimi_root(profile), cwd, after)
}

pub(super) fn kimi_session_dir_in(root: &Path, cwd: Option<&str>, after: Option<i64>) -> Option<PathBuf> {
    let states: Vec<PathBuf> =
        kimi_session_dirs_in(root).into_iter().map(|d| d.join("state.json")).collect();

    let matches_cwd = |state_path: &Path| -> bool {
        if after.is_some() && state_path.parent().and_then(kimi_session_id).is_some_and(|id| is_excluded(&id)) {
            return false;
        }
        let Some(cwd) = cwd else { return true };
        match kimi_state(state_path.parent().unwrap_or(state_path)).as_ref().and_then(kimi_declared_cwd) {
            Some(declared) => declared == Path::new(cwd),
            // Sin cwd declarado no se puede descartar: se acepta y decide `after`.
            None => true,
        }
    };

    newest_where(&states, after, matches_cwd)
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

pub(super) fn kimi_session_dir_by_id(session_id: &str, profile: Option<&Path>) -> Option<PathBuf> {
    kimi_session_dirs(profile)
        .into_iter()
        .find(|d| kimi_session_id(d).as_deref() == Some(session_id))
}

/// `agents/main/wire.jsonl` es el stream del agente principal — la conversación. Los
/// `agents/agent-N/` son sub-agentes y no van al export.
pub(super) fn kimi_wire_file(dir: &Path) -> Option<PathBuf> {
    let wire = dir.join("agents/main/wire.jsonl");
    wire.is_file().then_some(wire)
}

/// Título de una sesión de Kimi. A diferencia del resto de los agentes no hay que deducirlo
/// del primer mensaje: Kimi lo guarda en `state.json` (y el usuario puede fijarlo a mano con
/// `/title`). `lastPrompt` es el respaldo cuando todavía no le puso título.
pub(super) fn kimi_title(dir: &Path, fallback: &str) -> SessionTitleResult {
    let Some(state) = kimi_state(dir) else { return fallback_result(fallback) };

    if let Some(s) = state.get("title").and_then(|v| v.as_str()) {
        if !s.trim().is_empty() && !echoes_ade_notice(s) {
            return SessionTitleResult { title: truncate(s, 60), source: "summary".into() };
        }
    }
    // `lastPrompt` es un mensaje del usuario: puede ser un envoltorio, igual que el resto.
    if let Some(clean) = state.get("lastPrompt").and_then(|v| v.as_str()).and_then(clean_message) {
        return SessionTitleResult { title: truncate(&clean, 60), source: "first_message".into() };
    }
    fallback_result(fallback)
}

// ── TUIs personalizadas ───────────────────────────────────────────────

/// Archivo de sesión más reciente de una TUI custom: el más nuevo bajo la carpeta que el
/// usuario declaró, buscando tanto `.jsonl` como `.json` (las dos formas que usan los CLIs
// ── Hermes Agent ──────────────────────────────────────────────────────────────────────────────────────────────
//
// As sessões vivem no SQLite `<home>/state.db` (tabela `sessions`: `id`, `source`, `cwd`, `started_at` em segundos com
// fração, `title`; tabela `messages`: `session_id`, `role`, `content`). O home é `HERMES_HOME`, ou `%LOCALAPPDATA%\hermes` no
// Windows e `~/.hermes` no resto (o próprio Hermes cita `~/AppData/Local/hermes/config.yaml` na ajuda do Windows).

/// Origens de sessão que nascem de um terminal (a da aba). `desktop`, `acp`, `oneshot`, `subagent`, gateways: nunca.
const HERMES_TERMINAL_SOURCES: [&str; 2] = ["cli", "tui"];

pub(super) fn hermes_home(profile: Option<&Path>) -> PathBuf {
    if let Some(dir) = profile {
        return dir.to_path_buf();
    }
    if let Some(home) = std::env::var_os("HERMES_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home);
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
            return PathBuf::from(local).join("hermes");
        }
    }
    dirs::home_dir().unwrap_or_default().join(".hermes")
}

/// O banco do Hermes só para leitura (ele é quem escreve). `None` = sem banco ainda.
fn hermes_db(home: &Path) -> Option<rusqlite::Connection> {
    let path = home.join("state.db");
    if !path.exists() {
        return None;
    }
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = rusqlite::Connection::open_with_flags(&path, flags).ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    Some(conn)
}

/// A mesma pasta, como o Hermes a gravou: no Windows sem diferença de maiúsculas nem de separador, e sem a barra final. Pura.
pub(super) fn hermes_same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.trim().trim_end_matches(['/', '\\']).to_string();
        if cfg!(windows) { p.replace('/', "\\").to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

/// A sessão de terminal do Hermes neste cwd. Com `after` (a abertura da aba, em segundos), a PRIMEIRA que nasceu depois e que
/// não é de outra aba (`is_excluded`); sem `after`, a mais recente do cwd.
pub(super) fn hermes_session_id(home: &Path, cwd: &str, after: Option<i64>) -> Option<String> {
    let conn = hermes_db(home)?;
    let mut stmt = conn
        .prepare("SELECT id, cwd, started_at, source FROM sessions WHERE cwd IS NOT NULL ORDER BY started_at DESC LIMIT 400")
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, Option<String>>(3)?))
        })
        .ok()?;
    let mut found: Vec<(String, f64)> = rows
        .flatten()
        .filter(|(_, dir, _, source)| {
            hermes_same_dir(dir, cwd) && source.as_deref().is_some_and(|s| HERMES_TERMINAL_SOURCES.contains(&s))
        })
        .map(|(id, _, started, _)| (id, started))
        .collect();
    match after {
        Some(after) => {
            found.retain(|(id, started)| *started as i64 >= after && !is_excluded(id));
            found.sort_by(|a, b| a.1.total_cmp(&b.1));
            found.into_iter().next().map(|(id, _)| id)
        }
        None => found.into_iter().next().map(|(id, _)| id),
    }
}

/// As primeiras mensagens do usuário de uma sessão, como texto. `None` = sem banco ou sessão.
pub(super) fn hermes_user_texts(home: &Path, session_id: &str) -> Option<Vec<String>> {
    let conn = hermes_db(home)?;
    let mut stmt = conn
        .prepare("SELECT content FROM messages WHERE session_id = ?1 AND role = 'user' ORDER BY id LIMIT 8")
        .ok()?;
    let rows = stmt.query_map([session_id], |r| r.get::<_, Option<String>>(0)).ok()?;
    Some(
        rows.flatten()
            .flatten()
            .filter_map(|content| match serde_json::from_str::<Value>(&content) {
                // Conteúdo multimodal vem como lista de partes em JSON; texto puro, como string.
                Ok(value @ Value::Array(_)) => extract_text_block(&value),
                _ => Some(content),
            })
            .collect(),
    )
}

/// O título de uma sessão do Hermes: o que ele mesmo deu (`title`), senão a primeira mensagem do usuário.
pub(super) fn hermes_title(home: &Path, session_id: &str, fallback: &str) -> SessionTitleResult {
    let named = hermes_db(home).and_then(|conn| {
        conn.query_row("SELECT title FROM sessions WHERE id = ?1", [session_id], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten()
    });
    if let Some(title) = named.map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && !echoes_ade_notice(t)) {
        return SessionTitleResult { title: truncate(&title, 80), source: "summary".to_string() };
    }
    hermes_user_texts(home, session_id)
        .and_then(|texts| texts.into_iter().find_map(|t| clean_message(&t)))
        .map(|first| SessionTitleResult { title: truncate(&first, 80), source: "first_message".to_string() })
        .unwrap_or_else(|| fallback_result(fallback))
}

/// conocidos). A diferencia de las TUIs de fábrica no se filtra por cwd — no hay forma
/// genérica de saber cómo esa TUI mapea un proyecto a una carpeta — así que el filtro por
/// `after` (el momento en que arrancó ESTE proceso) es lo único que evita agarrar la
/// sesión de otra tab. Por eso `get_session_title` no lo usa sin un `after`.
pub(super) fn custom_session_file(agent: &crate::agents::CustomAgent, after: Option<i64>) -> Option<PathBuf> {
    let root = agent.resolved_sessions_dir()?;
    let mut files = Vec::new();
    collect_files(&root, "jsonl", &mut files);
    collect_files(&root, "json", &mut files);
    if after.is_some() {
        files.retain(|p| !custom_session_id(agent, p).is_some_and(|id| is_excluded(&id)));
    }
    newest_matching(&files, after, None)
}

/// Archivo de la sesión con ESTE id exacto, ya sea porque el id es el nombre del archivo
/// o porque aparece adentro. Recorre la carpeta declarada; devuelve `None` si no aparece.
pub(super) fn custom_session_file_by_id(
    agent: &crate::agents::CustomAgent,
    session_id: &str,
) -> Option<PathBuf> {
    let root = agent.resolved_sessions_dir()?;
    let mut files = Vec::new();
    collect_files(&root, "jsonl", &mut files);
    collect_files(&root, "json", &mut files);
    files.into_iter().find(|p| custom_session_id(agent, p).as_deref() == Some(session_id))
}

pub(super) fn custom_session_id(agent: &crate::agents::CustomAgent, path: &Path) -> Option<String> {
    match agent.session_id_source() {
        crate::agents::SessionIdSource::Filename => {
            path.file_stem().map(|s| s.to_string_lossy().to_string())
        }
        crate::agents::SessionIdSource::Field(key) => find_string_field(path, &[key.as_str()]),
    }
}

/// Título de una sesión de TUI custom: se reusa la heurística genérica de "primer mensaje
/// del usuario" que ya sirve para Codex, porque cubre las formas JSONL más comunes
/// (`role: user` + `content` string o bloques de texto) sin conocer el formato exacto.
pub(super) fn custom_title(path: &Path, fallback: &str) -> SessionTitleResult {
    codex_title(path, fallback)
}

/// Qué estrategia de descubrimiento le toca a esta TUI.
///
/// El mapeo agente → formato sale del registro (`agents/registry.rs`), así que la tabla de
/// "quién guarda sus sesiones de qué forma" vive en un solo lado; los algoritmos, acá. Una
/// TUI que no está en el registro cae en `None`, que es la rama de las TUIs custom: son
/// justamente las que declaran a mano dónde buscar.
fn source_of(agent_id: &str) -> SessionSource {
    // La fila del provider elige la estrategia. El `match` de abajo sigue siendo el parser
    // de cada formato. Una TUI que no está en el registro cae en `None`: es la rama custom.
    crate::agents::adapter_for(agent_id)
        .map(|adapter| adapter.def().sessions)
        .unwrap_or(SessionSource::None)
}

/// Binario y variable de cuenta de OpenCode, leídos de su fila.
///
/// El parser de su JSON sigue siendo de OpenCode. El nombre del ejecutable y la variable
/// no: si la fila cambia, `session list` y `export` siguen a la fila.
pub(super) fn opencode_invocation() -> (&'static str, &'static str) {
    let def = crate::agents::adapter_for("opencode").map(|adapter| adapter.def());
    (
        def.map(|d| d.command).unwrap_or("opencode"),
        def.and_then(|d| d.profile).map(|p| p.env_var).unwrap_or("XDG_DATA_HOME"),
    )
}

/// Archivo de sesión de una entrada del historial, resolviendo por el camino propio de
/// cada agente. A diferencia de `get_session_title`, acá interesa el archivo en sí (para
/// leer la conversación entera), y se acepta el "más reciente del cwd" cuando no hay
/// `session_id`: en un export, mostrar la sesión más probable es mejor que no mostrar nada.
pub fn session_file_for(
    agent_id: &str,
    cwd: &str,
    session_id: Option<&str>,
    // Directorio de la cuenta con la que corrió la sesión; `None` = la del sistema.
    profile: Option<&Path>,
    db: &tauri::State<crate::database::DbConnection>,
) -> Option<PathBuf> {
    match source_of(agent_id) {
        SessionSource::ClaudeProjects => claude_session_file(cwd, session_id, None, profile),
        SessionSource::GeminiTmp => {
            let home = gemini_home(profile);
            match session_id {
                Some(id) => gemini_session_file_by_id(&home, cwd, id),
                None => gemini_session_file_in(&home, cwd, None),
            }
        }
        SessionSource::CodexRollouts => codex_session_file(cwd, None, profile),
        // OpenCode no expone un archivo de sesión legible; su transcripción se pide con
        // `opencode export <id>` y la maneja `export::opencode_transcript` aparte.
        SessionSource::ProcessQuery => None,
        // Hermes: a conversa está no SQLite dele, não num arquivo por sessão.
        SessionSource::HermesState => None,
        // Kimi guarda la conversación en el wire del agente principal, no en un archivo
        // por sesión: se resuelve primero la carpeta y de ahí se baja al `wire.jsonl`.
        SessionSource::KimiSessions => {
            let dir = match session_id {
                Some(id) => kimi_session_dir_by_id(id, profile),
                None => kimi_session_dir(Some(cwd), None, profile),
            }?;
            kimi_wire_file(&dir)
        }
        SessionSource::None => {
            let conn = db.lock().ok()?;
            let agent = crate::agents::find(&conn, agent_id)?;
            drop(conn);
            match session_id {
                Some(id) => custom_session_file_by_id(&agent, id),
                None => custom_session_file(&agent, None),
            }
        }
    }
}

// ── Comandos públicos ─────────────────────────────────────────────────

/// Busca el archivo/registro de sesión más reciente para `cwd` (creado después de
/// `started_after`) y devuelve el session_id real que el agente le asignó, para poder
/// reanudarlo más adelante con la flag de resume de cada CLI.
///
/// **Corre en `spawn_blocking` y no directo.** Un `#[tauri::command]` declarado como `fn`
/// (sin `async`) lo ejecuta Tauri **en el hilo principal**, que es el del bucle de eventos
/// de la ventana. Y este trabajo no es instantáneo: para OpenCode levanta un proceso
/// (`opencode session list`, ~0.65s medidos) y para el resto lee metadata de disco. Como
/// el frontend lo llama cada pocos segundos por cada tab, el hilo principal quedaba
/// congelado en ráfagas justo mientras la terminal intentaba pintar sus primeros bytes —
/// se veía como una terminal negra que nunca arranca. Es el mismo problema que ya tenía
/// `agents::detect_agents`, resuelto igual.
#[tauri::command]
pub async fn discover_session_id(
    agent_id: String,
    cwd: String,
    started_after: i64,
    // Cuenta con la que corre la tab, si no es la del sistema. Se recibe el id y no la
    // ruta: la cuenta puede haberse mudado desde que la tab se guardó.
    account_id: Option<String>,
    // Sessões que já são de outras abas abertas: a descoberta não as devolve.
    exclude: Option<Vec<String>>,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<Option<String>, String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let profile = account_id.and_then(|id| crate::accounts::dir_for(&db, &id));
        let custom = db.lock().ok().and_then(|conn| crate::agents::find(&conn, &agent_id));
        discover_session_id_sync(
            &agent_id,
            &cwd,
            started_after,
            profile.as_deref().map(Path::new),
            custom.as_ref(),
            exclude.as_deref().unwrap_or(&[]),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// Si un id de sesión se puede pegar en la línea de comandos de reanudación sin riesgo.
///
/// Los ids salen de nombres y contenidos de archivos que la propia TUI (o cualquier agente)
/// puede escribir, y van a parar a un comando que se parte por espacios y, con prelaunch en
/// Windows, pasa por `cmd /C`: un archivo llamado `x --dangerously-skip-permissions.jsonl`
/// o `x & calc.jsonl` inyectaría un flag o un comando. Los ids reales (UUID, `ses_…`,
/// `rollout-…`) caben de sobra en este alfabeto, y no pueden empezar con `-`.
pub fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// [`discover_unchecked`], descartando ids que no pasan [`is_safe_session_id`].
pub(crate) fn discover_session_id_sync(
    agent_id: &str,
    cwd: &str,
    started_after: i64,
    profile: Option<&Path>,
    custom: Option<&crate::agents::CustomAgent>,
    exclude: &[String],
) -> Option<String> {
    // `exclude`: as sessões que já são de outras abas abertas (ver `is_excluded`).
    let _guard = ExcludeGuard::set(exclude);
    discover_unchecked(agent_id, cwd, started_after, profile, custom).filter(|id| is_safe_session_id(id))
}

/// `custom` es la TUI personalizada ya resuelta, o `None` para las de fábrica.
///
/// Se recibe resuelta en vez de un `DbConnection` porque hay un llamador que YA tiene la
/// conexión tomada (`archive_tab_row`): volver a pedir el lock desde adentro contra un
/// `Mutex` no reentrante sería un deadlock, no un error.
fn discover_unchecked(
    agent_id: &str,
    cwd: &str,
    started_after: i64,
    profile: Option<&Path>,
    custom: Option<&crate::agents::CustomAgent>,
) -> Option<String> {
    let cwd = cwd.to_string();
    match source_of(agent_id) {
        SessionSource::ClaudeProjects => {
            let path = claude_session_file(&cwd, None, Some(started_after), profile)?;
            path.file_stem().map(|s| s.to_string_lossy().to_string())
        }
        SessionSource::GeminiTmp => {
            let path = gemini_session_file(&cwd, Some(started_after), profile)?;
            // `sessionId` está en la cabecera; `find_string_field` queda de respaldo por si
            // una versión emite el archivo sin ella.
            gemini_meta(&path)
                .and_then(|m| m.session_id)
                .or_else(|| find_string_field(&path, &["sessionId", "session_id"]))
        }
        SessionSource::CodexRollouts => {
            let path = codex_session_file(&cwd, Some(started_after), profile)?;
            // La cabecera `session_meta` trae el id; `find_string_field` queda como respaldo
            // por si una versión emite el rollout sin cabecera reconocible.
            codex_meta(&path)
                .and_then(|m| m.id)
                .or_else(|| find_string_field(&path, &["session_id", "id"]))
        }
        SessionSource::ProcessQuery => {
            opencode_session(&cwd, Some(started_after), profile).map(|s| s.id)
        }
        SessionSource::KimiSessions => {
            let dir = kimi_session_dir(Some(&cwd), Some(started_after), profile)?;
            kimi_session_id(&dir)
        }
        SessionSource::HermesState => hermes_session_id(&hermes_home(profile), &cwd, Some(started_after)),
        // TUI custom: solo si el usuario declaró dónde guarda sus sesiones.
        SessionSource::None => {
            let agent = custom?;
            let path = custom_session_file(agent, Some(started_after))?;
            custom_session_id(agent, &path)
        }
    }
}

/// Genera un título legible para la tab a partir de la sesión real del agente.
/// Si el agente no es soportado o no se encuentra la sesión, devuelve `fallback`.
///
/// En `spawn_blocking` por el mismo motivo que `discover_session_id`: lee sesiones de
/// disco y, para OpenCode, levanta un proceso.
#[tauri::command]
pub async fn get_session_title(
    agent_id: String,
    cwd: String,
    session_id: Option<String>,
    fallback: String,
    account_id: Option<String>,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<SessionTitleResult, String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let profile = account_id.and_then(|id| crate::accounts::dir_for(&db, &id));
        let custom = db.lock().ok().and_then(|conn| crate::agents::find(&conn, &agent_id));
        get_session_title_sync(
            &agent_id,
            &cwd,
            session_id,
            fallback,
            profile.as_deref().map(Path::new),
            custom.as_ref(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// `custom` viene resuelta por el llamador, por el mismo motivo que en
/// `discover_session_id_sync`: hay quien llama con la conexión ya tomada.
pub(crate) fn get_session_title_sync(
    agent_id: &str,
    cwd: &str,
    session_id: Option<String>,
    fallback: String,
    profile: Option<&Path>,
    custom: Option<&crate::agents::CustomAgent>,
) -> SessionTitleResult {
    let cwd = cwd.to_string();
    match source_of(agent_id) {
        SessionSource::ClaudeProjects => match claude_session_file(&cwd, session_id.as_deref(), None, profile) {
            Some(path) => claude_title(&path, &fallback),
            None => fallback_result(&fallback),
        },
        SessionSource::HermesState => {
            let home = hermes_home(profile);
            match session_id.or_else(|| hermes_session_id(&home, &cwd, None)) {
                Some(id) => hermes_title(&home, &id, &fallback),
                None => fallback_result(&fallback),
            }
        }
        SessionSource::GeminiTmp => {
            let home = gemini_home(profile);
            let found = match session_id.as_deref() {
                Some(id) => gemini_session_file_by_id(&home, &cwd, id),
                None => gemini_session_file_in(&home, &cwd, None),
            };
            match found {
                Some(path) => cached_title(&path, &fallback, || gemini_title(&path, &fallback)),
                None => fallback_result(&fallback),
            }
        }
        SessionSource::CodexRollouts => {
            let found = match session_id.as_deref() {
                Some(id) => codex_session_file_by_id(id, profile),
                None => codex_session_file(&cwd, None, profile),
            };
            match found {
                Some(path) => cached_title(&path, &fallback, || codex_title(&path, &fallback)),
                None => fallback_result(&fallback),
            }
        }
        SessionSource::KimiSessions => {
            let found = match session_id.as_deref() {
                Some(id) => kimi_session_dir_by_id(id, profile),
                None => kimi_session_dir(Some(&cwd), None, profile),
            };
            match found {
                Some(dir) => kimi_title(&dir, &fallback),
                None => fallback_result(&fallback),
            }
        }
        // Se busca por id exacto cuando se conoce: "la más reciente del cwd" podría ser la
        // de otra tab abierta en la misma carpeta y el título quedaría cruzado.
        SessionSource::ProcessQuery => {
            let found = match session_id.as_deref() {
                Some(id) => opencode_sessions(&cwd, profile).into_iter().find(|s| s.id == id),
                None => opencode_session(&cwd, None, profile),
            };
            match found {
                Some(s) if !s.title.trim().is_empty() && !opencode_is_placeholder_title(&s.title) && !echoes_ade_notice(&s.title) => {
                    SessionTitleResult { title: truncate(&s.title, 60), source: "summary".into() }
                }
                _ => fallback_result(&fallback),
            }
        }
        // TUI custom: se busca el archivo por su id exacto, nunca "el más reciente" — sin
        // saber cómo esa TUI mapea proyectos a carpetas, "el más reciente" podría ser la
        // sesión de otra tab y el título quedaría cruzado.
        SessionSource::None => {
            let Some(id) = session_id else { return fallback_result(&fallback) };
            let Some(agent) = custom else { return fallback_result(&fallback) };
            match custom_session_file_by_id(agent, &id) {
                Some(path) => custom_title(&path, &fallback),
                None => fallback_result(&fallback),
            }
        }
    }
}

// ── Actividad de la sesión ────────────────────────────────────────────

/// Briefings que las misiones escriben como primer mensaje del usuario. Van en minúsculas:
/// se comparan contra el mensaje limpio, también en minúsculas.
const MISSION_BRIEF_MARKERS: &[&str] = &[
    "você é o orquestrador da missão",
    "você faz parte da equipe da missão",
    "você é o vigia",
];

/// `true` si [`session_activity`] puede medir este agente sin levantar un proceso. OpenCode
/// necesita `opencode session list`, y medirlo en cada pasada de refresco no vale el costo.
pub(crate) fn activity_is_measurable(agent_id: &str) -> bool {
    !matches!(source_of(agent_id), SessionSource::ProcessQuery)
}

/// Clasifica los primeros mensajes del usuario de una sesión: `mission` si alguno arranca
/// como briefing de misión, `task` si alguno sirve como mensaje, `empty` si ninguno sirve.
fn activity_of<'a>(messages: impl IntoIterator<Item = &'a str>) -> &'static str {
    let mut has_task = false;
    for msg in messages {
        let Some(clean) = clean_message(msg) else { continue };
        let lower = clean.to_lowercase();
        if MISSION_BRIEF_MARKERS.iter().any(|marker| lower.starts_with(marker)) {
            return "mission";
        }
        has_task = true;
    }
    if has_task { "task" } else { "empty" }
}

/// Textos de los primeros mensajes del usuario de un transcript (hasta [`TITLE_SCAN_LIMIT`]).
/// `extract` devuelve el texto de una línea, o `None` si esa línea no es un mensaje del
/// usuario. `None` si el archivo no se puede leer.
fn first_user_texts(path: &Path, extract: fn(&Value) -> Option<String>) -> Option<Vec<String>> {
    let content = fs::read_to_string(path).ok()?;
    let mut texts = Vec::new();
    for line in content.lines() {
        if texts.len() >= TITLE_SCAN_LIMIT {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(text) = extract(&v) {
            texts.push(text);
        }
    }
    Some(texts)
}

fn claude_user_text(v: &Value) -> Option<String> {
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    v.get("message").and_then(|m| m.get("content")).and_then(extract_text_block)
}

fn gemini_user_text(v: &Value) -> Option<String> {
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    v.get("content").and_then(extract_text_block)
}

/// Mismas formas que lee [`codex_title`], sin el contexto sintético que Codex inyecta.
fn codex_user_text(v: &Value) -> Option<String> {
    let msg_type = v.get("type").and_then(|t| t.as_str());
    let text = if msg_type == Some("event_msg") {
        let payload = v.get("payload")?;
        if payload.get("type").and_then(|t| t.as_str()) != Some("user_message") {
            return None;
        }
        payload.get("message").and_then(|m| m.as_str())?.to_string()
    } else if msg_type == Some("response_item") {
        let body = v.get("payload").unwrap_or(v);
        if body.get("role").and_then(|r| r.as_str()) != Some("user") {
            return None;
        }
        body.get("content").and_then(extract_text_block)?
    } else {
        return None;
    };
    (!codex_is_synthetic(&text)).then_some(text)
}

/// Actividad de una sesión (`task`, `empty`, `mission`) leyendo su transcripción, o `None`
/// si no se puede medir: archivo ausente, id inseguro, agente que solo se consulta con un
/// proceso (OpenCode) o TUI custom sin declarar (`custom` es `None`).
///
/// Recibe el perfil de cuenta y la TUI custom ya resueltos, igual que
/// [`get_session_title_sync`]: quien la llama puede tener la conexión tomada.
pub fn session_activity(
    agent_id: &str,
    cwd: &str,
    session_id: &str,
    profile: Option<&Path>,
    custom: Option<&crate::agents::CustomAgent>,
) -> Option<&'static str> {
    // El id termina en un nombre de archivo: nada que no sea un id real.
    if !is_safe_session_id(session_id) {
        return None;
    }
    match source_of(agent_id) {
        // Solo el archivo con ese id exacto. `claude_session_file` caería a "el más nuevo",
        // y la actividad de OTRA sesión quedaría grabada en esta.
        SessionSource::ClaudeProjects => {
            let path = claude_project_dir(cwd, profile).join(format!("{session_id}.jsonl"));
            let texts = first_user_texts(&path, claude_user_text)?;
            Some(activity_of(texts.iter().map(String::as_str)))
        }
        SessionSource::GeminiTmp => {
            let path = gemini_session_file_by_id(&gemini_home(profile), cwd, session_id)?;
            let texts = first_user_texts(&path, gemini_user_text)?;
            Some(activity_of(texts.iter().map(String::as_str)))
        }
        SessionSource::CodexRollouts => {
            let path = codex_session_file_by_id(session_id, profile)?;
            let texts = first_user_texts(&path, codex_user_text)?;
            Some(activity_of(texts.iter().map(String::as_str)))
        }
        SessionSource::ProcessQuery => None,
        SessionSource::HermesState => {
            let texts = hermes_user_texts(&hermes_home(profile), session_id)?;
            Some(activity_of(texts.iter().map(String::as_str)))
        }
        // Kimi no tiene un formato de wire verificado acá: se mide solo con `lastPrompt`. Si
        // ese prompt no sirve, no se afirma "vacía": queda sin medir.
        SessionSource::KimiSessions => {
            let dir = kimi_session_dir_by_id(session_id, profile)?;
            let state = kimi_state(&dir)?;
            let last = state.get("lastPrompt").and_then(|v| v.as_str())?;
            match activity_of([last]) {
                "empty" => None,
                activity => Some(activity),
            }
        }
        SessionSource::None => {
            let path = custom_session_file_by_id(custom?, session_id)?;
            let texts = first_user_texts(&path, codex_user_text)?;
            Some(activity_of(texts.iter().map(String::as_str)))
        }
    }
}
