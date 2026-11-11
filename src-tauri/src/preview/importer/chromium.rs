//! Cookies do Chromium (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Helium…): leitura do banco e decifra.
//!
//! Leitura: o `Cookies` (e `-wal`/`-journal`) vai para uma pasta temporária privada e só a cópia é aberta,
//! somente leitura. A revisão (`review`) conta domínios sem decifrar nada e **não precisa de chave**:
//! o Keychain só é consultado quando a pessoa confirma a importação (`decrypt`).
//!
//! Cifra (OSCrypt):
//! - macOS: `v10` = AES-128-CBC, IV de 16 espaços, chave = PBKDF2-HMAC-SHA1(senha do Keychain, "saltysalt", 1003).
//!   A senha vem do item "<Navegador> Safe Storage", lido só no clique (o macOS pede permissão).
//! - Linux: `v10` = AES-128-CBC com a senha padrão `peanuts` (PBKDF2, 1 iteração), usada quando o navegador não
//!   tem cofre; `v11` = a mesma cifra com a senha do Secret Service (libsecret, atributo `application`), lida só
//!   no clique de confirmar (`libsecret.rs`). Como no T3, os dois tentam também a chave de senha vazia
//!   (crbug.com/1195256). Falha do cofre que não seja falta de aprovação não impede o `v10`.
//! - Windows: `v10` = AES-256-GCM, chave do `Local State` protegida pelo DPAPI do usuário. Se o `Local State`
//!   tem `app_bound_encrypted_key` (Chrome 127+, Edge e outros), a chave é amarrada ao app e **a ADE não
//!   contorna isso**: a fonte fica indisponível com `app-bound`.
//! - Chromium 127+ (esquema do banco >= 24) prefixa o texto claro com o SHA-256 do `host_key`; sem esse
//!   prefixo certo, a linha é descartada (é o que também rejeita uma chave errada).
//!
//! A chave e a senha ficam só na memória (zeradas ao soltar, na medida do possível) e nunca vão a
//! log, arquivo ou ambiente.

use std::collections::BTreeSet;
use std::num::NonZeroU32;
use std::path::Path;

use aes::Aes128;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use ring::{aead, digest, pbkdf2};
use rusqlite::{Connection, OpenFlags};

use super::super::log::SetCookie;
use super::copy::{copy_sqlite_with_sidecars, TempCopy};
use super::{confirm_closed, normalize_domain, Candidate, ImportError, Reading};
use super::sources::Platform;

/// O IV do OSCrypt em modo CBC é fixo: 16 espaços.
const AES_CBC_IV: [u8; 16] = [0x20; 16];
const KEY_SALT: &[u8] = b"saltysalt";
const MAC_ITERATIONS: u32 = 1003;
/// No Linux o Chromium deriva a chave com uma única iteração.
const LINUX_ITERATIONS: u32 = 1;
/// A senha padrão do Chromium no Linux quando não há cofre (libsecret/KWallet).
const LINUX_FALLBACK_PASSPHRASE: &[u8] = b"peanuts";
const GCM_NONCE: usize = 12;
const GCM_TAG: usize = 16;
/// Microssegundos entre 1601-01-01 (época do WebKit) e 1970-01-01, em segundos.
const WEBKIT_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;
/// Primeira versão do esquema em que o texto claro leva o SHA-256 do domínio na frente.
const DOMAIN_BINDING_SCHEMA: i64 = 24;

/// As chaves de decifra de um navegador, só em memória.
#[derive(Default)]
pub(crate) struct Keys {
    pub cbc_v10: Option<[u8; 16]>,
    /// Linux: a chave do `v11`, da senha do Secret Service.
    pub cbc_v11: Option<[u8; 16]>,
    /// Linux: por que o `v11` não tem chave (cofre ausente, item ausente…). Só vira erro se nada decifra.
    pub cbc_v11_error: Option<ImportError>,
    /// Linux: alguns clientes cifram com senha vazia; é a segunda tentativa de `v10` e `v11`.
    pub cbc_empty: Option<[u8; 16]>,
    pub gcm_v10: Option<[u8; 32]>,
}

impl Keys {
    /// As chaves do Windows: só a AES-GCM do `v10`. (`Keys` implementa `Drop`, então não aceita `..Default`.)
    pub(crate) fn gcm(key: [u8; 32]) -> Self {
        let mut keys = Keys::default();
        keys.gcm_v10 = Some(key);
        keys
    }
}

impl Drop for Keys {
    fn drop(&mut self) {
        // Melhor esforço sem `unsafe`: zera e impede o compilador de descartar a escrita.
        for key in [self.cbc_v10.as_mut(), self.cbc_v11.as_mut(), self.cbc_empty.as_mut()].into_iter().flatten() {
            key.fill(0);
            std::hint::black_box(&*key);
        }
        if let Some(key) = self.gcm_v10.as_mut() {
            key.fill(0);
            std::hint::black_box(&*key);
        }
    }
}

/// Deriva a chave AES-128 do OSCrypt a partir da senha do navegador.
pub(crate) fn derive_cbc_key(passphrase: &[u8], iterations: u32) -> [u8; 16] {
    let mut key = [0u8; 16];
    let iterations = NonZeroU32::new(iterations).unwrap_or(NonZeroU32::MIN);
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA1, iterations, KEY_SALT, passphrase, &mut key);
    key
}

/// As chaves do macOS a partir da senha do Keychain.
pub(crate) fn mac_keys(secret: &[u8]) -> Keys {
    let mut keys = Keys::default();
    keys.cbc_v10 = Some(derive_cbc_key(secret, MAC_ITERATIONS));
    keys
}

/// As chaves do Linux. O `v10` usa sempre a senha padrão; a senha do Secret Service (`keyring`, lida só no
/// clique) abre o `v11`. `keyring` é `None` se a fonte não tem aplicação no cofre.
/// - cofre indisponível ou sem o item: o `v10` segue valendo e o motivo fica em `cbc_v11_error`;
/// - recusa ou cancelamento (`needs-keychain-approval`): a pessoa não aprovou, então a importação para.
pub(crate) fn linux_keys(keyring: Option<Result<Vec<u8>, ImportError>>) -> Result<Keys, ImportError> {
    let mut keys = Keys::default();
    keys.cbc_v10 = Some(derive_cbc_key(LINUX_FALLBACK_PASSPHRASE, LINUX_ITERATIONS));
    keys.cbc_empty = Some(derive_cbc_key(b"", LINUX_ITERATIONS));
    match keyring {
        None => {}
        Some(Ok(mut secret)) => {
            keys.cbc_v11 = Some(derive_cbc_key(&secret, LINUX_ITERATIONS));
            secret.fill(0);
        }
        Some(Err(error)) if error.code == "needs-keychain-approval" => return Err(error),
        Some(Err(error)) => keys.cbc_v11_error = Some(error),
    }
    Ok(keys)
}

/// Lê a senha do Chromium no Secret Service do Linux (libsecret). Só no clique de confirmar.
#[cfg(target_os = "linux")]
pub(crate) fn read_linux_secret(application: &str) -> Result<Vec<u8>, ImportError> {
    super::libsecret::read_chromium_secret(application)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn read_linux_secret(_application: &str) -> Result<Vec<u8>, ImportError> {
    Err(ImportError::new("unsupported-platform"))
}

/// Lê a senha "<Navegador> Safe Storage" do Keychain do macOS (Security framework, via `keyring`).
/// Só é chamada no clique de confirmar: o macOS mostra o pedido de permissão ao usuário. A senha volta
/// em bytes, sem passar por log.
#[cfg(target_os = "macos")]
pub(crate) fn read_keychain_secret(service: &str, account: &str) -> Result<Vec<u8>, ImportError> {
    let entry = keyring::Entry::new(service, account).map_err(|e| map_keyring_error(&e))?;
    match entry.get_secret() {
        Ok(secret) if secret.is_empty() => Err(ImportError::new("keychain-item-missing")),
        Ok(secret) => Ok(secret),
        Err(e) => Err(map_keyring_error(&e)),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_keychain_secret(_service: &str, _account: &str) -> Result<Vec<u8>, ImportError> {
    Err(ImportError::new("unsupported-platform"))
}

// Só o `read_keychain_secret` do macOS a chama (e os testes): nos outros sistemas ela não tem uso.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
/// Sem item no Keychain, a pessoa nunca abriu aquele navegador; qualquer outra recusa (permissão
/// negada, Keychain bloqueado, prompt cancelado) é falta de aprovação.
pub(crate) fn map_keyring_error(error: &keyring::Error) -> ImportError {
    match error {
        keyring::Error::NoEntry => ImportError::new("keychain-item-missing"),
        // O detalhe do erro do keyring nunca traz a senha; ainda assim só o tipo vai adiante.
        keyring::Error::NoStorageAccess(_) => ImportError::new("needs-keychain-approval"),
        _ => ImportError::new("needs-keychain-approval"),
    }
}

/// O `Local State` do Windows: se a chave é amarrada ao app, a fonte não pode ser importada; senão,
/// devolve a chave embrulhada pelo DPAPI (sem o prefixo `DPAPI`).
pub(crate) fn windows_wrapped_key(local_state: &str) -> Result<Vec<u8>, ImportError> {
    use base64::Engine;
    let value: serde_json::Value =
        serde_json::from_str(local_state).map_err(|_| ImportError::new("unreadable").with("o Local State não é um JSON válido"))?;
    let crypt = value.get("os_crypt").ok_or_else(|| ImportError::new("unreadable").with("o Local State não tem os_crypt"))?;
    if crypt.get("app_bound_encrypted_key").is_some() {
        return Err(ImportError::new("app-bound"));
    }
    let encoded = crypt
        .get("encrypted_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ImportError::new("unreadable").with("o Local State não tem encrypted_key"))?;
    let wrapped = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ImportError::new("unreadable").with("encrypted_key não é base64"))?;
    wrapped
        .strip_prefix(b"DPAPI")
        .map(<[u8]>::to_vec)
        .ok_or_else(|| ImportError::new("unreadable").with("encrypted_key sem o prefixo DPAPI"))
}

/// Desembrulha a chave do Windows com o DPAPI do usuário atual (PowerShell, entrada por `stdin`).
#[cfg(windows)]
pub(crate) fn unwrap_dpapi(wrapped: &[u8]) -> Result<[u8; 32], ImportError> {
    use base64::Engine;
    use std::time::Duration;
    const SCRIPT: &str = "Add-Type -AssemblyName System.Security;\
        $value=[Console]::In.ReadToEnd();\
        $encrypted=[Convert]::FromBase64String($value);\
        $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);\
        [Console]::Out.Write([Convert]::ToBase64String($plain))";
    let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR"));
    let program = root
        .map(|r| std::path::PathBuf::from(r).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe"))
        .unwrap_or_else(|| "powershell.exe".into());
    let mut command = crate::util::spawn::hidden_command(program);
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", SCRIPT]);
    let input = base64::engine::general_purpose::STANDARD.encode(wrapped).into_bytes();
    let out = crate::util::spawn::output_with_input(&mut command, Some(input), Duration::from_secs(20))
        .map_err(|e| ImportError::new("keychain-unavailable").with(e.to_string()))?;
    if !out.status.success() {
        return Err(ImportError::new("unreadable").with("o DPAPI recusou a chave"));
    }
    let plain = base64::engine::general_purpose::STANDARD
        .decode(String::from_utf8_lossy(&out.stdout).trim())
        .map_err(|_| ImportError::new("unreadable").with("o DPAPI devolveu algo que não é base64"))?;
    <[u8; 32]>::try_from(plain.as_slice()).map_err(|_| ImportError::new("unreadable").with("a chave do DPAPI não tem 32 bytes"))
}

#[cfg(not(windows))]
pub(crate) fn unwrap_dpapi(_wrapped: &[u8]) -> Result<[u8; 32], ImportError> {
    Err(ImportError::new("unsupported-platform"))
}

/// Uma fila crua de `cookies`.
pub(crate) struct RawRow {
    pub host_key: String,
    pub name: String,
    pub value: String,
    pub encrypted: Vec<u8>,
    pub path: String,
    /// Microssegundos desde 1601; 0 é cookie de sessão.
    pub expires_utc: i64,
    pub is_secure: bool,
    pub is_http_only: bool,
    pub same_site: i64,
    pub top_frame_site_key: String,
}

/// O que se leu do banco copiado: as filas e a versão do esquema.
pub(crate) struct Snapshot {
    pub rows: Vec<RawRow>,
    pub schema_version: i64,
}

/// Copia o banco para uma pasta privada e lê as filas. Confere o bloqueio (`in_use(root)`) antes e depois da cópia.
pub(crate) fn read_snapshot(
    db: &Path,
    lock_root: &Path,
    tmp_root: &Path,
    in_use: &dyn Fn(&Path) -> Result<bool, String>,
) -> Result<Snapshot, ImportError> {
    confirm_closed(lock_root, in_use)?;
    let copy = TempCopy::create(tmp_root)?;
    let copied = copy_sqlite_with_sidecars(db, copy.path())?;
    confirm_closed(lock_root, in_use)?;
    read_rows(&copied)
}

fn read_rows(db: &Path) -> Result<Snapshot, ImportError> {
    let bad = |e: rusqlite::Error| ImportError::new("unreadable").with(e.to_string());
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(bad)?;
    let schema_version: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'version' LIMIT 1", [], |row| {
            use rusqlite::types::ValueRef;
            Ok(match row.get_ref(0)? {
                ValueRef::Integer(n) => n,
                ValueRef::Text(t) => String::from_utf8_lossy(t).trim().parse().unwrap_or(0),
                _ => 0,
            })
        })
        .map_err(|_| ImportError::new("unreadable").with("o banco de cookies não tem a versão do esquema"))?;
    let mut columns_stmt = conn.prepare("PRAGMA table_info(cookies)").map_err(bad)?;
    let columns: Vec<String> = columns_stmt.query_map([], |row| row.get::<_, String>(1)).map_err(bad)?.filter_map(Result::ok).collect();
    if columns.is_empty() {
        return Err(ImportError::new("unreadable").with("o banco não tem a tabela cookies"));
    }
    let top_frame = if columns.iter().any(|c| c == "top_frame_site_key") { "top_frame_site_key" } else { "''" };
    let sql = format!(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, {top_frame} FROM cookies"
    );
    let mut stmt = conn.prepare(&sql).map_err(bad)?;
    let rows = stmt
        .query_map([], |row| {
            use rusqlite::types::ValueRef;
            let text = |i: usize| -> rusqlite::Result<String> {
                Ok(match row.get_ref(i)? {
                    ValueRef::Text(b) | ValueRef::Blob(b) => String::from_utf8_lossy(b).into_owned(),
                    _ => String::new(),
                })
            };
            let encrypted = match row.get_ref(3)? {
                ValueRef::Blob(b) | ValueRef::Text(b) => b.to_vec(),
                _ => Vec::new(),
            };
            Ok(RawRow {
                host_key: text(0)?,
                name: text(1)?,
                value: text(2)?,
                encrypted,
                path: text(4)?,
                expires_utc: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                is_secure: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                is_http_only: row.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
                same_site: row.get::<_, Option<i64>>(8)?.unwrap_or(-1),
                top_frame_site_key: text(9)?,
            })
        })
        .map_err(bad)?;
    let rows = rows.collect::<Result<Vec<_>, _>>().map_err(bad)?;
    Ok(Snapshot { rows, schema_version })
}

fn unix_expiry(expires_utc: i64) -> Option<i64> {
    (expires_utc > 0).then(|| expires_utc / 1_000_000 - WEBKIT_EPOCH_OFFSET_SECONDS)
}

/// O domínio de uma fila que pode entrar: nome e domínio válidos, não vencida e não particionada.
enum Verdict {
    Keep { domain: String, expires_at: Option<i64> },
    Ignored,
    Dropped,
}

fn judge(row: &RawRow, now_secs: i64) -> Verdict {
    if row.name.is_empty() {
        return Verdict::Dropped;
    }
    let Some(domain) = normalize_domain(&row.host_key) else {
        return Verdict::Dropped;
    };
    let expires_at = unix_expiry(row.expires_utc);
    if expires_at.is_some_and(|at| at <= now_secs) {
        return Verdict::Dropped;
    }
    // Cookie particionado (CHIPS): o preview guarda por origem, sem chave de partição.
    if !row.top_frame_site_key.is_empty() {
        return Verdict::Ignored;
    }
    Verdict::Keep { domain, expires_at }
}

/// A revisão: domínios e contagens, **sem decifrar nada** (os valores ficam vazios e não saem daqui).
pub(crate) fn review(snapshot: &Snapshot, now_secs: i64) -> Reading {
    let mut reading = Reading::default();
    for row in &snapshot.rows {
        match judge(row, now_secs) {
            Verdict::Keep { domain, .. } => reading.cookies.push(Candidate {
                domain,
                secure: row.is_secure,
                cookie: SetCookie {
                    name: row.name.clone(),
                    value: String::new(),
                    path: None,
                    http_only: row.is_http_only,
                    secure: row.is_secure,
                    same_site: None,
                    expires_at: None,
                    url: String::new(),
                    at: 0,
                },
            }),
            Verdict::Ignored => reading.ignored += 1,
            Verdict::Dropped => {}
        }
    }
    reading
}

/// Os domínios marcados que existem no banco (para saber, antes de pedir a chave, se há o que decifrar).
pub(crate) fn has_wanted(snapshot: &Snapshot, wanted: &BTreeSet<String>, now_secs: i64) -> bool {
    snapshot.rows.iter().any(|row| matches!(judge(row, now_secs), Verdict::Keep { ref domain, .. } if wanted.contains(domain)))
}

/// Decifra só as filas dos domínios marcados. O que não decifra (chave errada, `v11` sem chave, `v20`)
/// conta em `undecryptable`.
pub(crate) fn decrypt(snapshot: &Snapshot, wanted: &BTreeSet<String>, keys: &Keys, platform: Platform, now_secs: i64) -> Reading {
    let mut reading = Reading::default();
    for row in &snapshot.rows {
        match judge(row, now_secs) {
            Verdict::Ignored => reading.ignored += 1,
            Verdict::Dropped => {}
            Verdict::Keep { domain, expires_at } => {
                if !wanted.contains(&domain) {
                    continue;
                }
                let value = if row.encrypted.is_empty() {
                    Some(row.value.clone())
                } else {
                    decrypt_value(&row.encrypted, keys, &row.host_key, snapshot.schema_version, platform)
                };
                let Some(value) = value else {
                    reading.undecryptable += 1;
                    continue;
                };
                let same_site = match row.same_site {
                    0 => Some("None"),
                    1 => Some("Lax"),
                    2 => Some("Strict"),
                    // -1 é "não especificado": não adivinhar `None`, que alargaria o escopo.
                    _ => None,
                }
                .map(str::to_string);
                let path = if row.path.starts_with('/') { row.path.clone() } else { "/".to_string() };
                reading.cookies.push(Candidate {
                    domain,
                    secure: row.is_secure,
                    cookie: SetCookie {
                        name: row.name.clone(),
                        value,
                        path: Some(path),
                        http_only: row.is_http_only,
                        secure: row.is_secure,
                        same_site,
                        expires_at,
                        url: String::new(),
                        at: 0,
                    },
                });
            }
        }
    }
    reading
}

/// Decifra um `encrypted_value`. `None` se a versão não tem chave, se a chave não abre ou se o
/// texto não é UTF-8 válido (sinal de chave errada).
pub(crate) fn decrypt_value(encrypted: &[u8], keys: &Keys, host_key: &str, schema_version: i64, platform: Platform) -> Option<String> {
    if encrypted.len() < 3 {
        return None;
    }
    let (prefix, payload) = encrypted.split_at(3);
    // Cada versão tem a sua chave e, fora do Windows, a de senha vazia como segunda tentativa.
    let cbc = |primary: Option<&[u8; 16]>| -> Option<Vec<u8>> {
        let open = |key: &[u8; 16]| strip_domain_binding(decrypt_cbc(payload, key)?, host_key, schema_version);
        open(primary?).or_else(|| keys.cbc_empty.as_ref().and_then(open))
    };
    let plain = match (platform, prefix) {
        (Platform::Windows, b"v10") => strip_domain_binding(decrypt_gcm(payload, keys.gcm_v10.as_ref()?)?, host_key, schema_version)?,
        // `v20` no Windows é a cifra amarrada ao app: sem chave aqui, nunca contornada.
        (Platform::Windows, _) => return None,
        (_, b"v10") => cbc(keys.cbc_v10.as_ref())?,
        // `v11` é a senha do Secret Service (Linux): sem ela (`cbc_v11` vazio), nunca decifra.
        (_, b"v11") => cbc(keys.cbc_v11.as_ref())?,
        // Sem prefixo de versão, o Chromium guarda o texto claro no `encrypted_value`.
        _ => strip_domain_binding(encrypted.to_vec(), host_key, schema_version)?,
    };
    String::from_utf8(plain).ok()
}

/// Se a importação falhou porque a chave do `v11` não veio: o erro do cofre, quando nenhum cookie marcado
/// decifrou e há ao menos um `v11` marcado. Sem isso, a pessoa veria só "não decifrou" sem saber o motivo.
pub(crate) fn v11_key_error(snapshot: &Snapshot, wanted: &BTreeSet<String>, keys: &Keys, now_secs: i64) -> Option<ImportError> {
    let error = keys.cbc_v11_error.as_ref()?;
    snapshot
        .rows
        .iter()
        .any(|row| {
            row.encrypted.starts_with(b"v11") && matches!(judge(row, now_secs), Verdict::Keep { ref domain, .. } if wanted.contains(domain))
        })
        .then(|| error.clone())
}

fn decrypt_cbc(payload: &[u8], key: &[u8; 16]) -> Option<Vec<u8>> {
    let mut buffer = payload.to_vec();
    let plain = cbc::Decryptor::<Aes128>::new_from_slices(key, &AES_CBC_IV).ok()?.decrypt_padded_mut::<Pkcs7>(&mut buffer).ok()?;
    Some(plain.to_vec())
}

fn decrypt_gcm(payload: &[u8], key: &[u8; 32]) -> Option<Vec<u8>> {
    if payload.len() < GCM_NONCE + GCM_TAG {
        return None;
    }
    let (nonce, rest) = payload.split_at(GCM_NONCE);
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).ok()?);
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce).ok()?;
    let mut buffer = rest.to_vec();
    let plain = key.open_in_place(nonce, aead::Aad::empty(), &mut buffer).ok()?;
    Some(plain.to_vec())
}

/// Chromium 127+ (esquema >= 24): o texto claro começa com o SHA-256 do `host_key`.
fn strip_domain_binding(plain: Vec<u8>, host_key: &str, schema_version: i64) -> Option<Vec<u8>> {
    if schema_version < DOMAIN_BINDING_SCHEMA {
        return Some(plain);
    }
    let hash = digest::digest(&digest::SHA256, host_key.as_bytes());
    (plain.len() >= 32 && plain[..32] == *hash.as_ref()).then(|| plain[32..].to_vec())
}

/// Se há um navegador Chromium com o perfil aberto (Unix): o `SingletonLock` é um link simbólico
/// `host-pid`. Um pid que não existe mais é um bloqueio velho. Só consulta; nunca apaga o link.
#[cfg(unix)]
pub(crate) fn profile_in_use(root: &Path) -> Result<bool, String> {
    let target = match std::fs::read_link(root.join("SingletonLock")) {
        Ok(target) => target,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let text = target.to_string_lossy();
    let Some((_, pid)) = text.rsplit_once('-') else {
        return Ok(true);
    };
    let Ok(pid) = pid.parse::<i32>() else {
        return Ok(true);
    };
    if pid <= 0 {
        return Ok(true);
    }
    // SAFETY: `kill(pid, 0)` não envia sinal: só testa se o processo existe.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return Ok(true);
    }
    // Só `ESRCH` prova um bloqueio velho; `EPERM` e o resto podem esconder um navegador ativo.
    Ok(std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH))
}

/// No Windows o Chromium trava o arquivo de cookies sem compartilhamento: abrir sem compartilhar falha
/// com o código 32 se o navegador o tem aberto. `root` é a pasta do perfil (onde fica o `Network\Cookies`).
#[cfg(windows)]
pub(crate) fn profile_in_use(db: &Path) -> Result<bool, String> {
    use std::os::windows::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new().read(true).share_mode(0).open(db) {
        Ok(_) => Ok(false),
        Err(e) if e.raw_os_error() == Some(32) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}
