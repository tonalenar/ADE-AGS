//! Os perfis do Firefox (e do Zen, que usa o mesmo formato) e a leitura dos cookies sem tocar no original.
//! O Chromium está em `chromium.rs` e o Safari em `safari.rs`.
//!
//! Leitura: o `cookies.sqlite` (e o `-wal`, se existir) é copiado para uma pasta temporária
//! privada, e só a cópia é aberta, em modo somente leitura. O original não recebe nada: nem `-wal`,
//! nem `-shm`, nem bloqueio. O bloqueio do perfil é conferido antes e depois da cópia.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::super::log::SetCookie;
use super::copy::{copy_file, TempCopy};
use super::{normalize_domain, Candidate, ImportError, Reading};

/// Os arquivos de bloqueio do Firefox dentro da pasta do perfil. `parent.lock` aparece no Windows
/// e no macOS; `.parentlock`, no Linux. A conferência olha os dois, em qualquer sistema.
const LOCK_FILES: [&str; 2] = ["parent.lock", ".parentlock"];

const COOKIES: &str = "cookies.sqlite";
const COOKIES_WAL: &str = "cookies.sqlite-wal";

/// Acima deste valor, `expiry` está em milissegundos (é o ano 9999, em segundos).
const MAX_SECONDS: i64 = 253_402_300_799;

/// Um perfil listado em `profiles.ini`.
#[derive(Debug)]
pub(crate) struct Profile {
    pub id: String,
    pub name: String,
    pub dir: PathBuf,
}

/// Uma fila crua de `moz_cookies`, antes da classificação.
pub(crate) struct RawRow {
    pub origin_attributes: String,
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub expiry: i64,
    pub is_secure: bool,
    pub is_http_only: bool,
    pub same_site: i64,
    pub partitioned_flag: bool,
}

/// O destino de uma fila: entra, fica de fora por ser particionada ou de outro contêiner, ou se descarta.
pub(crate) enum Classified {
    Keep(Candidate),
    Ignored,
    Dropped,
}

/// Os perfis que o `profiles.ini` da raiz declara. Sem o arquivo, não há perfis (e não é erro).
pub(crate) fn profiles(root: &Path) -> Result<Vec<Profile>, ImportError> {
    let text = match std::fs::read_to_string(root.join("profiles.ini")) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(ImportError::new("unreadable").with(e.to_string())),
    };
    Ok(parse_ini(&text)
        .into_iter()
        .filter(|(section, _)| is_profile_section(section))
        .filter_map(|(section, pairs)| {
            let path = value(&pairs, "Path")?;
            let relative = value(&pairs, "IsRelative") != Some("0");
            // Um caminho relativo com `..` escaparia da pasta do navegador.
            if relative && !super::sources::stays_inside(Path::new(path)) {
                return None;
            }
            let dir = if relative { root.join(path) } else { PathBuf::from(path) };
            let name = value(&pairs, "Name").filter(|n| !n.is_empty()).unwrap_or(&section).to_string();
            Some(Profile { id: section, name, dir })
        })
        .collect())
}

#[cfg(test)]
/// O perfil com esse id. Só aceita um id que o `profiles.ini` declara: o caminho nunca vem do chamador.
pub(crate) fn find_profile(root: &Path, id: &str) -> Result<Profile, ImportError> {
    profiles(root)?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| ImportError::new("no-profile"))
}

/// Se o Firefox tem o perfil aberto. Só consulta: nunca cria nem solta um bloqueio.
pub(crate) fn profile_in_use(dir: &Path) -> Result<bool, String> {
    for name in LOCK_FILES {
        let lock = dir.join(name);
        match std::fs::symlink_metadata(&lock) {
            Ok(_) => {
                if lock_held(&lock)? {
                    return Ok(true);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(false)
}

/// Se outro processo segura o arquivo de bloqueio. Em Unix, um `F_GETLK` de escrita (que não cria
/// nem solta nada); no Windows, abrir sem compartilhamento, que falha se o Firefox tem o arquivo.
#[cfg(unix)]
fn lock_held(lock: &Path) -> Result<bool, String> {
    use std::os::unix::io::AsRawFd;
    // Só leitura: abrir para escrita, ou com `O_CREAT`/`O_TRUNC`, poderia mexer no arquivo do Firefox.
    let file = std::fs::File::open(lock).map_err(|e| e.to_string())?;
    // SAFETY: o registro `flock` é zerado e preenchido só com o pedido de consulta; `fcntl(F_GETLK)`
    // devolve quem segura o bloqueio e não cria nem solta nenhum.
    let mut probe: libc::flock = unsafe { std::mem::zeroed() };
    probe.l_type = libc::F_WRLCK as libc::c_short;
    probe.l_whence = libc::SEEK_SET as libc::c_short;
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut probe as *mut libc::flock) };
    if rc == -1 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(probe.l_type != libc::F_UNLCK as libc::c_short)
}

#[cfg(windows)]
fn lock_held(lock: &Path) -> Result<bool, String> {
    use std::os::windows::fs::OpenOptionsExt;
    // Sem compartilhamento: se o Firefox tem o arquivo aberto, a abertura falha com "violação de
    // compartilhamento" (código 32).
    match std::fs::OpenOptions::new().read(true).share_mode(0).open(lock) {
        Ok(_) => Ok(false),
        Err(e) if e.raw_os_error() == Some(32) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(any(unix, windows)))]
fn lock_held(_lock: &Path) -> Result<bool, String> {
    Err("este sistema não tem como conferir o bloqueio do perfil".to_string())
}

/// Lê os cookies de um perfil por uma cópia temporária privada. Confere o bloqueio antes de copiar e
/// de novo depois, para descartar a leitura se o Firefox abriu no meio.
pub(crate) fn read_profile_cookies(
    dir: &Path,
    tmp_root: &Path,
    in_use: &dyn Fn(&Path) -> Result<bool, String>,
    now_secs: i64,
) -> Result<Reading, ImportError> {
    if !dir.join(COOKIES).is_file() {
        return Err(ImportError::new("no-cookies"));
    }
    confirm_closed(dir, in_use)?;
    let copy = TempCopy::create(tmp_root)?;
    copy_file(&dir.join(COOKIES), &copy.path().join(COOKIES))?;
    if dir.join(COOKIES_WAL).is_file() {
        copy_file(&dir.join(COOKIES_WAL), &copy.path().join(COOKIES_WAL))?;
    }
    confirm_closed(dir, in_use)?;
    let rows = read_rows(&copy.path().join(COOKIES))?;
    Ok(classify_all(rows, now_secs))
}

fn confirm_closed(dir: &Path, in_use: &dyn Fn(&Path) -> Result<bool, String>) -> Result<(), ImportError> {
    match in_use(dir) {
        Ok(false) => Ok(()),
        Ok(true) => Err(ImportError::new("browser-running")),
        Err(detail) => Err(ImportError::new("lock-unknown").with(detail)),
    }
}

/// Lê `moz_cookies` da cópia, em modo somente leitura. Usa `isPartitionedAttributeSet` só se a
/// versão do Firefox tiver a coluna.
fn read_rows(db: &Path) -> Result<Vec<RawRow>, ImportError> {
    let bad = |e: rusqlite::Error| ImportError::new("unreadable").with(e.to_string());
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(bad)?;
    let mut columns_stmt = conn.prepare("PRAGMA table_info(moz_cookies)").map_err(bad)?;
    let columns: Vec<String> = columns_stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(bad)?
        .filter_map(Result::ok)
        .collect();
    if columns.is_empty() {
        return Err(ImportError::new("unreadable").with("o cookies.sqlite não tem a tabela moz_cookies"));
    }
    let partition = if columns.iter().any(|c| c == "isPartitionedAttributeSet") { "isPartitionedAttributeSet" } else { "0" };
    let sql = format!(
        "SELECT originAttributes, host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, {partition} FROM moz_cookies"
    );
    let mut stmt = conn.prepare(&sql).map_err(bad)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RawRow {
                origin_attributes: text(row, 0)?,
                host: text(row, 1)?,
                name: text(row, 2)?,
                value: text(row, 3)?,
                path: text(row, 4)?,
                expiry: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                is_secure: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                is_http_only: row.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
                same_site: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                partitioned_flag: row.get::<_, Option<i64>>(9)?.unwrap_or(0) != 0,
            })
        })
        .map_err(bad)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(bad)
}

/// Um texto da coluna, sem falhar com valores que o Firefox guarda como blob.
fn text(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<String> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(index)? {
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        _ => String::new(),
    })
}

fn classify_all(rows: Vec<RawRow>, now_secs: i64) -> Reading {
    let mut reading = Reading::default();
    for row in rows {
        match classify(row, now_secs) {
            Classified::Keep(candidate) => reading.cookies.push(candidate),
            Classified::Ignored => reading.ignored += 1,
            Classified::Dropped => {}
        }
    }
    reading
}

/// As regras de entrada de uma fila. Vencida ou sem domínio válido, se descarta; particionada ou
/// de outro contêiner (ou de navegação privada, ou de primeira parte isolada), fica de fora e conta.
pub(crate) fn classify(row: RawRow, now_secs: i64) -> Classified {
    if row.name.is_empty() {
        return Classified::Dropped;
    }
    let Some(domain) = normalize_domain(&row.host) else {
        return Classified::Dropped;
    };
    let expires_at = if row.expiry == 0 { None } else { Some(seconds(row.expiry)) };
    if expires_at.is_some_and(|at| at <= now_secs) {
        return Classified::Dropped;
    }
    if row.partitioned_flag || !default_container(&row.origin_attributes) {
        return Classified::Ignored;
    }
    let path = if row.path.starts_with('/') { row.path } else { "/".to_string() };
    let same_site = match row.same_site {
        0 => Some("None"),
        1 => Some("Lax"),
        2 => Some("Strict"),
        _ => None,
    }
    .map(str::to_string);
    Classified::Keep(Candidate {
        domain,
        secure: row.is_secure,
        cookie: SetCookie {
            name: row.name,
            value: row.value,
            path: Some(path),
            http_only: row.is_http_only,
            secure: row.is_secure,
            same_site,
            expires_at,
            url: String::new(),
            at: 0,
        },
    })
}

/// `originAttributes` do Firefox (`^chave=valor&...`). Só o contêiner padrão e a janela normal
/// passam: qualquer outra chave (partição, primeira parte, outro contêiner) é uma sessão diferente.
fn default_container(attrs: &str) -> bool {
    let attrs = attrs.strip_prefix('^').unwrap_or(attrs);
    attrs
        .split('&')
        .filter(|pair| !pair.is_empty())
        .all(|pair| matches!(pair.split_once('='), Some(("userContextId" | "privateBrowsingId", "0"))))
}

fn seconds(expiry: i64) -> i64 {
    if expiry > MAX_SECONDS { expiry / 1000 } else { expiry }
}

/// As seções do `profiles.ini`, na ordem do arquivo, com seus pares `chave=valor`.
fn parse_ini(text: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
            sections.push((name.trim().to_string(), Vec::new()));
        } else if let (Some((key, val)), Some((_, pairs))) = (line.split_once('='), sections.last_mut()) {
            pairs.push((key.trim().to_string(), val.trim().to_string()));
        }
    }
    sections
}

fn is_profile_section(name: &str) -> bool {
    name.strip_prefix("Profile").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn value<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs.iter().find(|(k, _)| k.as_str() == key).map(|(_, v)| v.as_str())
}
