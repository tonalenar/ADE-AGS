//! Cookies do Safari (macOS): o formato `Cookies.binarycookies` e a checagem do Acesso Total ao Disco.
//!
//! O arquivo fica em `~/Library/Containers/com.apple.Safari/…`, protegido pelo TCC: sem Acesso Total ao
//! Disco, abrir o arquivo falha com `EPERM` (já o `stat` funciona, então a presença não prova que dá
//! para ler). O Safari grava o arquivo de forma atômica, então não há bloqueio a conferir.
//!
//! Formato (big-endian no cabeçalho, little-endian no corpo das páginas):
//! `"cook"`, `u32` páginas, `u32` tamanho de cada página, as páginas, checksum de 8 bytes e um plist opcional.
//! Cada página: `00 00 01 00`, `u32` cookies, `u32` offsets, `u32` 0, os registros. Cada registro: tamanho,
//! flags (1 = seguro, 4 = HttpOnly), offsets de url/nome/caminho/valor, expiração e criação (`f64`, segundos
//! desde 2001-01-01) e as strings terminadas em zero. Todo acesso é checado: um arquivo truncado ou com
//! offsets que se cruzam é recusado, nunca lido além do buffer.

use std::path::Path;

use super::super::log::SetCookie;
use super::copy::{is_full_disk_access_denied, read_error};
use super::{normalize_domain, Candidate, ImportError, Reading};

/// Segundos entre 1970-01-01 e 2001-01-01 (a época do Safari).
const APPLE_EPOCH_OFFSET_SECONDS: i64 = 978_307_200;
const PAGE_HEADER: usize = 12;
const RECORD_HEADER: usize = 56;
const FLAG_SECURE: u32 = 0x1;
const FLAG_HTTP_ONLY: u32 = 0x4;
/// Um arquivo maior que isto não é um jar de cookies do Safari: recusa antes de ler tudo para a memória.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn bad(detail: &str) -> ImportError {
    ImportError::new("unreadable").with(detail.to_string())
}

fn u32_be(buf: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(buf.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

fn u32_le(buf: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(buf.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

fn f64_le(buf: &[u8], at: usize) -> Option<f64> {
    Some(f64::from_le_bytes(buf.get(at..at.checked_add(8)?)?.try_into().ok()?))
}

/// A string terminada em zero que começa em `start` (sem o zero). `None` se `start` passa do buffer.
fn c_string(buf: &[u8], start: usize) -> Option<String> {
    let tail = buf.get(start..)?;
    let end = tail.iter().position(|&b| b == 0).unwrap_or(tail.len());
    Some(String::from_utf8_lossy(&tail[..end]).into_owned())
}

/// Lê o `Cookies.binarycookies` já em memória. Os cookies vencidos e os de domínio inválido saem.
pub(crate) fn parse_binary_cookies(buf: &[u8], now_secs: i64) -> Result<Reading, ImportError> {
    if buf.len() < 8 || &buf[..4] != b"cook" {
        return Err(bad("o arquivo não é um Cookies.binarycookies"));
    }
    let pages = u32_be(buf, 4).ok_or_else(|| bad("cabeçalho truncado"))? as usize;
    let sizes_end = pages.checked_mul(4).and_then(|n| n.checked_add(8)).filter(|&n| n <= buf.len()).ok_or_else(|| bad("tabela de páginas truncada"))?;
    let mut reading = Reading::default();
    let mut start = sizes_end;
    for index in 0..pages {
        let size = u32_be(buf, 8 + index * 4).ok_or_else(|| bad("tabela de páginas truncada"))? as usize;
        let end = start.checked_add(size).filter(|&e| size >= PAGE_HEADER && e <= buf.len()).ok_or_else(|| bad("página truncada"))?;
        parse_page(&buf[start..end], now_secs, &mut reading)?;
        start = end;
    }
    // Depois das páginas: nada, ou o checksum de 8 bytes, ou o checksum e um plist com o tamanho na frente.
    let trailer = buf.len() - start;
    let valid = trailer == 0
        || trailer == 8
        || (trailer >= 12 && u32_be(buf, start + 8).is_some_and(|n| trailer == 8 + 4 + n as usize));
    if !valid {
        return Err(bad("o arquivo termina com bytes que não são do formato"));
    }
    Ok(reading)
}

fn parse_page(page: &[u8], now_secs: i64, reading: &mut Reading) -> Result<(), ImportError> {
    let count = u32_le(page, 4).ok_or_else(|| bad("página truncada"))? as usize;
    let table_end = count.checked_mul(4).and_then(|n| n.checked_add(PAGE_HEADER)).filter(|&n| n <= page.len()).ok_or_else(|| bad("tabela de cookies truncada"))?;
    let mut accepted: Vec<(usize, usize)> = Vec::new();
    for index in 0..count {
        let start = u32_le(page, 8 + index * 4).ok_or_else(|| bad("tabela de cookies truncada"))? as usize;
        // Um offset para dentro do cabeçalho, da tabela ou de outro registro forjaria cookies.
        if start < table_end || start.checked_add(RECORD_HEADER).is_none_or(|e| e > page.len()) {
            return Err(bad("offset de cookie inválido"));
        }
        let size = u32_le(page, start).ok_or_else(|| bad("registro truncado"))? as usize;
        let end = start.checked_add(size).filter(|&e| size >= RECORD_HEADER && e <= page.len()).ok_or_else(|| bad("registro truncado"))?;
        if accepted.iter().any(|&(s, e)| start < e && end > s) {
            return Err(bad("registros de cookie sobrepostos"));
        }
        accepted.push((start, end));
        let record = &page[start..end];
        let flags = u32_le(record, 8).ok_or_else(|| bad("registro truncado"))?;
        let offsets = [16, 20, 24, 28].map(|at| u32_le(record, at).map(|o| o as usize));
        let [Some(url), Some(name), Some(path), Some(value)] = offsets else {
            return Err(bad("registro truncado"));
        };
        if [url, name, path, value].iter().any(|&o| o < RECORD_HEADER || o >= record.len()) {
            return Err(bad("offset de string inválido"));
        }
        let expiry = f64_le(record, 40).ok_or_else(|| bad("registro truncado"))?;
        let (Some(host), Some(name), Some(path), Some(value)) =
            (c_string(record, url), c_string(record, name), c_string(record, path), c_string(record, value))
        else {
            return Err(bad("string fora do registro"));
        };
        if name.is_empty() {
            continue;
        }
        let Some(domain) = normalize_domain(&host) else { continue };
        // `f64 as i64` satura; um valor absurdo vira uma data longínqua, nunca pânico.
        let expires_at = (expiry > 0.0).then(|| (expiry.floor() as i64).saturating_add(APPLE_EPOCH_OFFSET_SECONDS));
        if expires_at.is_some_and(|at| at <= now_secs) {
            continue;
        }
        let secure = flags & FLAG_SECURE != 0;
        reading.cookies.push(Candidate {
            domain,
            secure,
            cookie: SetCookie {
                name,
                value,
                path: Some(if path.starts_with('/') { path } else { "/".to_string() }),
                http_only: flags & FLAG_HTTP_ONLY != 0,
                secure,
                // A codificação do SameSite no Safari não é documentada: `Lax` é o padrão dos navegadores
                // e não alarga o escopo como `None` alargaria.
                same_site: Some("Lax".to_string()),
                expires_at,
                url: String::new(),
                at: 0,
            },
        });
    }
    Ok(())
}

/// Lê o arquivo de cookies do Safari. `needs-full-disk-access` se o TCC recusar; o arquivo só é lido,
/// nunca copiado nem alterado.
pub(crate) fn read_cookie_file(path: &Path, now_secs: i64) -> Result<Reading, ImportError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| read_error(&e))?;
    let size = file.metadata().map_err(|e| read_error(&e))?.len();
    if size > MAX_FILE_BYTES {
        return Err(bad("o arquivo de cookies é grande demais"));
    }
    let mut buf = Vec::with_capacity(size as usize);
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut buf).map_err(|e| read_error(&e))?;
    parse_binary_cookies(&buf, now_secs)
}

/// Dá para abrir o arquivo? `Err` com `needs-full-disk-access` se o TCC nega. Não lê o conteúdo.
pub(crate) fn access_denied(path: &Path) -> bool {
    match std::fs::File::open(path) {
        Ok(_) => false,
        Err(e) => is_full_disk_access_denied(&e),
    }
}
