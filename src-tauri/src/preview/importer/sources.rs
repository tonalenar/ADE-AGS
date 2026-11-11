//! Os navegadores que a ADE sabe importar: onde ficam os perfis em cada sistema, quais perfis existem
//! e se a fonte está disponível (instalada, fechada, com permissão). Só olha nomes e estrutura de
//! pastas: nunca lê cookie nem chave.
//!
//! O caminho de um perfil nunca vem da interface: o chamador manda o `id` de uma fonte e o `id` de um
//! perfil, e ambos só valem se esta listagem os produz.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::copy::{copy_sqlite_with_sidecars, TempCopy};
use super::{firefox, safari, BrowserProfile, ImportError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Engine {
    Chromium,
    Firefox,
    Safari,
}

/// Onde começa o caminho de uma fonte, por sistema.
#[derive(Clone, Copy, Debug)]
enum Base {
    /// macOS: `~/Library/Application Support`; Windows: `%APPDATA%`.
    Data,
    /// Windows: `%LOCALAPPDATA%`.
    Local,
    /// Linux: `~/.config`.
    Config,
    Home,
}

#[derive(Clone, Copy, Debug)]
struct Location {
    base: Base,
    segments: &'static [&'static str],
}

/// Um navegador importável.
pub(crate) struct Source {
    pub id: &'static str,
    pub name: &'static str,
    pub engine: Engine,
    /// Item do Keychain do macOS com a senha dos cookies (serviço, conta). Só Chromium.
    pub keychain: Option<(&'static str, &'static str)>,
    mac: Option<Location>,
    windows: Option<Location>,
    linux: Option<Location>,
    /// No Windows, a cifra é amarrada ao app (Chrome 127+ e derivados): a ADE não contorna isso.
    pub windows_app_bound: bool,
}

const fn loc(base: Base, segments: &'static [&'static str]) -> Option<Location> {
    Some(Location { base, segments })
}

#[allow(clippy::too_many_arguments)]
const fn chromium_source(
    id: &'static str,
    name: &'static str,
    keychain_service: &'static str,
    keychain_account: &'static str,
    mac: Option<&'static [&'static str]>,
    windows: Option<&'static [&'static str]>,
    app_bound: bool,
) -> Source {
    Source {
        id,
        name,
        engine: Engine::Chromium,
        keychain: Some((keychain_service, keychain_account)),
        mac: match mac {
            Some(segments) => loc(Base::Data, segments),
            None => None,
        },
        windows: match windows {
            Some(segments) => loc(Base::Local, segments),
            None => None,
        },
        // O `v11` do Linux guarda a senha no libsecret, que a ADE não lê: o Chromium não é oferecido lá.
        linux: None,
        windows_app_bound: app_bound,
    }
}

pub(crate) static SOURCES: &[Source] = &[
    chromium_source("chrome", "Chrome", "Chrome Safe Storage", "Chrome", Some(&["Google", "Chrome"]), Some(&["Google", "Chrome", "User Data"]), true),
    chromium_source("edge", "Microsoft Edge", "Microsoft Edge Safe Storage", "Microsoft Edge", Some(&["Microsoft Edge"]), Some(&["Microsoft", "Edge", "User Data"]), true),
    chromium_source("brave", "Brave", "Brave Safe Storage", "Brave", Some(&["BraveSoftware", "Brave-Browser"]), Some(&["BraveSoftware", "Brave-Browser", "User Data"]), true),
    chromium_source("vivaldi", "Vivaldi", "Vivaldi Safe Storage", "Vivaldi", Some(&["Vivaldi"]), Some(&["Vivaldi", "User Data"]), true),
    chromium_source("opera", "Opera", "Opera Safe Storage", "Opera", Some(&["com.operasoftware.Opera"]), None, true),
    chromium_source("arc", "Arc", "Arc Safe Storage", "Arc", Some(&["Arc", "User Data"]), None, false),
    chromium_source("helium", "Helium", "Helium Storage Key", "Helium", Some(&["net.imput.helium"]), Some(&["imput", "Helium", "User Data"]), false),
    Source {
        id: "safari",
        name: "Safari",
        engine: Engine::Safari,
        keychain: None,
        mac: loc(Base::Home, &["Library", "Containers", "com.apple.Safari", "Data", "Library"]),
        windows: None,
        linux: None,
        windows_app_bound: false,
    },
    Source {
        id: "firefox",
        name: "Firefox",
        engine: Engine::Firefox,
        keychain: None,
        mac: loc(Base::Data, &["Firefox"]),
        windows: loc(Base::Data, &["Mozilla", "Firefox"]),
        linux: loc(Base::Home, &[".mozilla", "firefox"]),
        windows_app_bound: false,
    },
    Source {
        id: "zen",
        name: "Zen",
        engine: Engine::Firefox,
        keychain: None,
        mac: loc(Base::Data, &["zen"]),
        windows: loc(Base::Data, &["zen"]),
        linux: loc(Base::Config, &["zen"]),
        windows_app_bound: false,
    },
];

pub(crate) fn find(id: &str) -> Option<&'static Source> {
    SOURCES.iter().find(|s| s.id == id)
}

/// Os diretórios-base do sistema. Nos testes, aponta para pastas temporárias.
pub(crate) struct Context {
    pub platform: Platform,
    pub home: Option<PathBuf>,
    pub data: Option<PathBuf>,
    pub local: Option<PathBuf>,
    pub config: Option<PathBuf>,
}

impl Context {
    pub(crate) fn current() -> Self {
        Self {
            platform: Platform::current(),
            home: dirs::home_dir(),
            data: dirs::data_dir(),
            local: dirs::data_local_dir(),
            config: dirs::config_dir(),
        }
    }
}

/// Por que a fonte não pode ser importada agora. Códigos estáveis: a interface traduz.
pub(crate) const NOT_INSTALLED: &str = "not-installed";
pub(crate) const UNSUPPORTED_PLATFORM: &str = "unsupported-platform";
pub(crate) const APP_BOUND: &str = "app-bound";
pub(crate) const BROWSER_RUNNING: &str = "browser-running";
pub(crate) const NEEDS_FULL_DISK_ACCESS: &str = "needs-full-disk-access";

/// Uma fonte como a interface a vê: perfis (id e nome, nunca caminho) e, se não dá para importar, o motivo.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub engine: Engine,
    pub profiles: Vec<BrowserProfile>,
    pub unavailable: Option<&'static str>,
}

/// Um perfil resolvido: onde estão os cookies e onde o navegador guarda o bloqueio de uso.
#[derive(Debug)]
pub(crate) struct ProfileEntry {
    pub id: String,
    pub name: String,
    /// Pasta do perfil (Firefox: a que `profiles.ini` declara).
    pub dir: PathBuf,
    pub cookie_db: PathBuf,
    /// O que se confere para saber se o navegador está aberto: no Unix, a raiz do navegador (onde fica o
    /// `SingletonLock` do Chromium); no Windows, o arquivo de cookies, que o navegador trava.
    pub lock_target: PathBuf,
}

impl Source {
    fn location(&self, platform: Platform) -> Option<Location> {
        match platform {
            Platform::Mac => self.mac,
            Platform::Windows => self.windows,
            Platform::Linux => self.linux,
        }
    }

    /// A pasta de dados do navegador neste sistema.
    pub(crate) fn root(&self, ctx: &Context) -> Option<PathBuf> {
        let location = self.location(ctx.platform)?;
        let base = match location.base {
            Base::Data => ctx.data.as_ref(),
            Base::Local => ctx.local.as_ref(),
            Base::Config => ctx.config.as_ref(),
            Base::Home => ctx.home.as_ref(),
        }?;
        Some(location.segments.iter().fold(base.clone(), |path, segment| path.join(segment)))
    }

    /// Esta fonte pode ser importada neste sistema? `unsupported-platform` ou, no Windows, `app-bound`.
    pub(crate) fn check_platform(&self, platform: Platform) -> Result<(), ImportError> {
        self.support(platform).map_or(Ok(()), |reason| Err(ImportError::new(reason)))
    }

    /// A fonte existe neste sistema? No Windows, o Chromium de cifra amarrada ao app não é importável.
    fn support(&self, platform: Platform) -> Option<&'static str> {
        if self.engine == Engine::Chromium && platform == Platform::Windows && self.windows_app_bound {
            return Some(APP_BOUND);
        }
        if self.location(platform).is_none() {
            return Some(UNSUPPORTED_PLATFORM);
        }
        None
    }
}

/// `true` se um nome de pasta de perfil é seguro: sem separador, `.`/`..` ou NUL. O nome vem do
/// `Local State` do navegador, que o usuário (ou outro programa) pode escrever.
fn safe_dir_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// Um caminho relativo sem `..`, raiz ou prefixo: não escapa da pasta onde é juntado.
pub(crate) fn stays_inside(relative: &Path) -> bool {
    relative.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// As fontes e seus perfis. Usa a pasta temporária só para olhar o `SafariTabs.db` (uma cópia).
pub(crate) fn list(ctx: &Context, tmp_root: &Path, in_use: &dyn Fn(Engine, &Path) -> Result<bool, String>) -> Vec<SourceInfo> {
    SOURCES
        .iter()
        .filter_map(|source| {
            let blocked = |reason: &'static str| SourceInfo { id: source.id, name: source.name, engine: source.engine, profiles: Vec::new(), unavailable: Some(reason) };
            if let Some(reason) = source.support(ctx.platform) {
                // Fora do sistema atual não aparece; já a cifra amarrada ao app é um aviso útil no Windows.
                return (reason == APP_BOUND).then(|| blocked(reason));
            }
            let entries = match profiles(source, ctx, tmp_root) {
                Ok(entries) if !entries.is_empty() => entries,
                _ => return Some(blocked(NOT_INSTALLED)),
            };
            let mut info = SourceInfo {
                id: source.id,
                name: source.name,
                engine: source.engine,
                profiles: entries.iter().map(|p| BrowserProfile { id: p.id.clone(), name: p.name.clone() }).collect(),
                unavailable: None,
            };
            if let Some(reason) = unavailable_reason(source, &entries, in_use) {
                info.unavailable = Some(reason);
            }
            Some(info)
        })
        .collect()
}

/// O estado de uma fonte instalada: Safari sem Acesso Total ao Disco e navegador aberto bloqueiam.
fn unavailable_reason(source: &Source, entries: &[ProfileEntry], in_use: &dyn Fn(Engine, &Path) -> Result<bool, String>) -> Option<&'static str> {
    match source.engine {
        Engine::Safari => entries.first().filter(|p| safari::access_denied(&p.cookie_db)).map(|_| NEEDS_FULL_DISK_ACCESS),
        // Uma consulta de bloqueio que falha conta como aberto: ler um banco em uso seria pior.
        Engine::Chromium | Engine::Firefox => {
            entries.iter().any(|p| in_use(source.engine, &p.lock_target).unwrap_or(true)).then_some(BROWSER_RUNNING)
        }
    }
}

/// Os perfis que têm um banco de cookies. Sem a pasta do navegador, a lista é vazia (e não é erro).
pub(crate) fn profiles(source: &Source, ctx: &Context, tmp_root: &Path) -> Result<Vec<ProfileEntry>, ImportError> {
    let Some(root) = source.root(ctx) else {
        return Ok(Vec::new());
    };
    match source.engine {
        Engine::Firefox => firefox_profiles(&root),
        Engine::Chromium => chromium_profiles(&root, ctx.platform),
        Engine::Safari => safari_profiles(&root, tmp_root),
    }
}

/// O perfil com esse id. Só vale um id que a listagem produz: o caminho nunca vem do chamador.
pub(crate) fn find_profile(source: &Source, ctx: &Context, tmp_root: &Path, id: &str) -> Result<ProfileEntry, ImportError> {
    profiles(source, ctx, tmp_root)?.into_iter().find(|p| p.id == id).ok_or_else(|| ImportError::new("no-profile"))
}

fn firefox_profiles(root: &Path) -> Result<Vec<ProfileEntry>, ImportError> {
    Ok(firefox::profiles(root)?
        .into_iter()
        .filter(|p| p.dir.join("cookies.sqlite").is_file())
        .map(|p| ProfileEntry { lock_target: p.dir.clone(), cookie_db: p.dir.join("cookies.sqlite"), id: p.id, name: p.name, dir: p.dir })
        .collect())
}

/// Prefere o `Network/Cookies` do Chromium 96+; o `Cookies` antigo sobra depois de uma atualização.
fn chromium_cookie_db(profile_dir: &Path) -> Option<PathBuf> {
    [profile_dir.join("Network").join("Cookies"), profile_dir.join("Cookies")].into_iter().find(|p| p.is_file())
}

fn chromium_profiles(root: &Path, platform: Platform) -> Result<Vec<ProfileEntry>, ImportError> {
    let declared: Vec<(String, String)> = std::fs::read_to_string(root.join("Local State"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("profile")?.get("info_cache")?.as_object().cloned())
        .map(|cache| {
            cache
                .into_iter()
                .map(|(dir, info)| {
                    let name = info.get("name").and_then(|n| n.as_str()).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&dir).to_string();
                    (dir, name)
                })
                .collect()
        })
        .unwrap_or_default();
    let candidates: Vec<(String, String)> = if declared.is_empty() {
        // Sem `Local State`, varre as pastas do navegador atrás de uma com banco de cookies.
        let mut dirs: Vec<String> = std::fs::read_dir(root)
            .map(|entries| entries.filter_map(Result::ok).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        dirs.sort();
        dirs.into_iter().map(|d| (d.clone(), d)).collect()
    } else {
        let mut declared = declared;
        declared.sort();
        declared
    };
    Ok(candidates
        .into_iter()
        .filter(|(dir, _)| safe_dir_name(dir))
        .filter_map(|(dir, name)| {
            let profile_dir = root.join(&dir);
            let cookie_db = chromium_cookie_db(&profile_dir)?;
            // Unix: o `SingletonLock` fica na raiz; Windows: o navegador trava o próprio arquivo de cookies.
            let lock_target = if platform == Platform::Windows { cookie_db.clone() } else { root.to_path_buf() };
            Some(ProfileEntry { id: dir, name, dir: profile_dir, cookie_db, lock_target })
        })
        .collect())
}

const SAFARI_JAR: &str = "Cookies.binarycookies";

fn is_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(len, part)| part.len() == *len && part.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `root` é `…/Containers/com.apple.Safari/Data/Library`. O perfil padrão tem o `Cookies/` ao lado;
/// os perfis nomeados do Safari 17+ têm um `WebKit/WebsiteDataStore/<uuid>/Cookies/` cada.
fn safari_profiles(library: &Path, tmp_root: &Path) -> Result<Vec<ProfileEntry>, ImportError> {
    let default_jar = library.join("Cookies").join(SAFARI_JAR);
    // `metadata` funciona sem o Acesso Total ao Disco; é só a presença do arquivo.
    if std::fs::metadata(&default_jar).map(|m| m.is_file()).unwrap_or(false) {
        let declared = safari_declared_profiles(library, tmp_root);
        let default_name = declared.iter().find(|(uuid, _)| uuid == "DefaultProfile").map(|(_, title)| title.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Safari".to_string());
        let mut entries = vec![ProfileEntry {
            id: "default".to_string(),
            name: default_name,
            dir: library.join("Cookies"),
            lock_target: default_jar.clone(),
            cookie_db: default_jar,
        }];
        for (uuid, title) in declared.into_iter().filter(|(uuid, _)| is_uuid(uuid)) {
            let uuid = uuid.to_ascii_lowercase();
            let dir = library.join("WebKit").join("WebsiteDataStore").join(&uuid).join("Cookies");
            let jar = dir.join(SAFARI_JAR);
            if std::fs::metadata(&jar).map(|m| m.is_file()).unwrap_or(false) {
                entries.push(ProfileEntry { id: uuid.clone(), name: if title.is_empty() { uuid } else { title }, dir, lock_target: jar.clone(), cookie_db: jar });
            }
        }
        return Ok(entries);
    }
    Ok(Vec::new())
}

/// Os perfis nomeados que o Safari declara em `SafariTabs.db` (título e uuid). Esse banco também fica atrás
/// do Acesso Total ao Disco e é do Safari: só se abre uma cópia, e qualquer falha vira "sem perfis nomeados".
fn safari_declared_profiles(library: &Path, tmp_root: &Path) -> Vec<(String, String)> {
    let db = library.join("Safari").join("SafariTabs.db");
    let Ok(copy) = TempCopy::create(tmp_root) else { return Vec::new() };
    let Ok(copied) = copy_sqlite_with_sidecars(&db, copy.path()) else { return Vec::new() };
    let Ok(conn) = rusqlite::Connection::open_with_flags(&copied, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare("SELECT title, external_uuid FROM bookmarks WHERE parent = 0 AND type = 1 AND subtype = 2 AND deleted = 0 ORDER BY order_index") else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |row| Ok((row.get::<_, Option<String>>(0)?.unwrap_or_default().trim().to_string(), row.get::<_, String>(1)?)));
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).map(|(title, uuid)| (uuid, title)).collect(),
        Err(_) => Vec::new(),
    }
}
