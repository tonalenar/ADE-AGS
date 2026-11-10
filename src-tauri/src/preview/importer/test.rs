//! Testes da importação de cookies do Firefox. Todos usam perfis sintéticos em diretórios temporários
//! e um keyring falso: nenhum perfil, cookie ou chave real é lido.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};

use super::firefox;
use super::{apply_profile, normalize_domain, origins_for, review_profile, DomainCount, ImportError};
use crate::preview::site::{key_result_from, KeyStore, SealKey, Site};

/// "Agora", em segundos. As datas das filas são relativas a este instante.
const AHORA: i64 = 1_900_000_000;
const AHORA_MS: i64 = AHORA * 1000;

/// Valores que nunca podem aparecer fora do estado cifrado.
const SECRETO_GITHUB: &str = "sessao-github-SEGREDO-7f3a";
const SECRETO_PREF: &str = "preferencia-SEGREDO-91bc";
const SECRETO_GOOGLE: &str = "google-SEGREDO-c0de";
const SECRETO_PARTICIONADO: &str = "particionada-SEGREDO-5e5e";
const SECRETO_CONTENEDOR: &str = "contenedor-SEGREDO-2b2b";

const INI: &str = "[General]\nStartWithLastProfile=1\nVersion=2\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n";

/// O esquema de `moz_cookies` (as colunas que o leitor usa, com as mesmas restrições do Firefox).
const ESQUEMA: &str = "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0, UNIQUE(name, host, path, originAttributes))";

/// Uma fila de `moz_cookies`, com os nomes de coluna do Firefox.
struct Fila {
    attrs: &'static str,
    host: &'static str,
    name: &'static str,
    value: &'static str,
    path: &'static str,
    expiry: i64,
    secure: i64,
    http_only: i64,
    same_site: i64,
}

/// Uma cookie de sessão, segura, em `/`, sem `SameSite`, no contêiner padrão.
fn fila(host: &'static str, name: &'static str, value: &'static str) -> Fila {
    Fila { attrs: "", host, name, value, path: "/", expiry: 0, secure: 1, http_only: 1, same_site: 0 }
}

fn insertar(conn: &Connection, filas: &[Fila]) {
    for f in filas {
        conn.execute(
            "INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![f.attrs, f.name, f.value, f.host, f.path, f.expiry, f.secure, f.http_only, f.same_site],
        )
        .unwrap();
    }
}

/// Un directorio temporario único para esta prueba.
fn lugar(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ade-ags-importar-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Un perfil de Firefox sintético: `profiles.ini` en la raíz y `cookies.sqlite` en la carpeta del perfil.
/// Devuelve (raíz, carpeta del perfil).
fn perfil(tag: &str, filas: &[Fila]) -> (PathBuf, PathBuf) {
    let raiz = lugar(tag);
    let dir = raiz.join("Profiles").join("abc.default-release");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(raiz.join("profiles.ini"), INI).unwrap();
    let conn = Connection::open(dir.join("cookies.sqlite")).unwrap();
    conn.execute_batch(ESQUEMA).unwrap();
    insertar(&conn, filas);
    (raiz, dir)
}

fn vacio(dir: &Path) -> bool {
    std::fs::read_dir(dir).unwrap().next().is_none()
}

/// Nombre y contenido de cada archivo de un directorio, para comparar antes y después.
fn retrato(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut archivos: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entrada| {
            let entrada = entrada.unwrap();
            (entrada.file_name().to_string_lossy().into_owned(), std::fs::read(entrada.path()).unwrap_or_default())
        })
        .collect();
    archivos.sort();
    archivos
}

fn contiene(bytes: &[u8], texto: &str) -> bool {
    bytes.windows(texto.len()).any(|w| w == texto.as_bytes())
}

fn cerrado(_: &Path) -> Result<bool, String> {
    Ok(false)
}

fn abierto(_: &Path) -> Result<bool, String> {
    Ok(true)
}

fn sin_permiso(_: &Path) -> Result<bool, String> {
    Err("sem permissão para ver o bloqueio".to_string())
}

/// Un keyring falso: la clave vive en memoria. El del sistema no se toca en las pruebas.
#[derive(Default)]
struct LlaveroFalso {
    valor: Mutex<Option<String>>,
}

impl KeyStore for LlaveroFalso {
    fn read_key(&self) -> Result<Option<String>, String> {
        Ok(self.valor.lock().unwrap().clone())
    }

    fn write_key(&self, value: &str) -> Result<(), String> {
        *self.valor.lock().unwrap() = Some(value.to_string());
        Ok(())
    }
}

/// Los sitios de una prueba: uno por origen, abiertos en `dir` con la misma clave. Se recuerdan para mirarlos.
struct Sitios {
    dir: PathBuf,
    clave: Arc<SealKey>,
    mapa: RefCell<HashMap<String, Arc<Site>>>,
}

impl Sitios {
    fn nuevo(dir: PathBuf) -> Self {
        let clave = key_result_from(&LlaveroFalso::default()).unwrap();
        Self { dir, clave, mapa: RefCell::new(HashMap::new()) }
    }

    fn sitio(&self, origen: &str) -> Arc<Site> {
        self.mapa
            .borrow_mut()
            .entry(origen.to_string())
            .or_insert_with(|| Site::open(origen, Some(self.dir.as_path()), Some(self.clave.clone())))
            .clone()
    }

    fn origenes(&self) -> Vec<String> {
        let mut origenes: Vec<String> = self.mapa.borrow().keys().cloned().collect();
        origenes.sort();
        origenes
    }

    fn nombres(&self, origen: &str, ahora: i64) -> Vec<String> {
        let mut nombres: Vec<String> = self.sitio(origen).cookies(ahora).into_iter().map(|c| c.name).collect();
        nombres.sort();
        nombres
    }
}

#[test]
fn los_perfiles_se_leen_de_profiles_ini_con_su_nombre() {
    let (raiz, _dir) = perfil("lista", &[fila("github.com", "sid", SECRETO_GITHUB)]);
    let perfiles = firefox::profiles(&raiz).unwrap();
    assert_eq!(perfiles.len(), 1);
    assert_eq!(perfiles[0].id, "Profile0");
    assert_eq!(perfiles[0].name, "default-release");
    assert!(firefox::profiles(&lugar("sin-ini")).unwrap().is_empty(), "sin profiles.ini no hay perfiles, y no es un error");
}

#[test]
fn un_id_que_profiles_ini_no_declara_se_recusa() {
    let (raiz, _dir) = perfil("ids", &[]);
    assert!(firefox::find_profile(&raiz, "Profile0").is_ok());
    for malo in ["", "Profile9", "../Profiles", "Profile0/../../etc"] {
        assert_eq!(firefox::find_profile(&raiz, malo).err().unwrap().code, "no-profile", "id: {malo}");
    }
}

#[test]
fn el_lector_no_toca_el_cookies_sqlite_original() {
    let (_raiz, dir) = perfil("original", &[fila("github.com", "sid", SECRETO_GITHUB)]);
    let antes = retrato(&dir);
    let copias = lugar("copias-original");
    let lectura = firefox::read_profile_cookies(&dir, &copias, &cerrado, AHORA).unwrap();
    assert_eq!(lectura.cookies.len(), 1);
    assert_eq!(retrato(&dir), antes, "el original no cambia: ni bytes ni archivos nuevos (-wal, -shm, -journal)");
    assert!(vacio(&copias), "la copia temporal se borra al terminar");
}

#[test]
fn un_firefox_abierto_se_recusa_antes_de_copiar_nada() {
    let (_raiz, dir) = perfil("abierto", &[fila("github.com", "sid", SECRETO_GITHUB)]);
    let copias = lugar("copias-abierto");
    let error = firefox::read_profile_cookies(&dir, &copias, &abierto, AHORA).err().unwrap();
    assert_eq!(error.code, "browser-running");
    assert!(vacio(&copias), "no llega a copiar nada");
}

#[test]
fn si_no_se_puede_confirmar_el_bloqueo_tambien_se_recusa() {
    let (_raiz, dir) = perfil("sin-confirmar", &[fila("github.com", "sid", SECRETO_GITHUB)]);
    let copias = lugar("copias-sin-confirmar");
    let error = firefox::read_profile_cookies(&dir, &copias, &sin_permiso, AHORA).err().unwrap();
    assert_eq!(error.code, "lock-unknown");
    assert!(vacio(&copias));
}

#[test]
fn si_el_firefox_abre_durante_la_copia_la_lectura_se_descarta() {
    let (_raiz, dir) = perfil("carrera", &[fila("github.com", "sid", SECRETO_GITHUB)]);
    let llamadas = AtomicUsize::new(0);
    // La primera mirada está cerrada; la segunda, después de copiar, ya lo encuentra abierto.
    let despues_de_copiar = |_: &Path| -> Result<bool, String> { Ok(llamadas.fetch_add(1, Ordering::SeqCst) > 0) };
    let copias = lugar("copias-carrera");
    let error = firefox::read_profile_cookies(&dir, &copias, &despues_de_copiar, AHORA).err().unwrap();
    assert_eq!(error.code, "browser-running");
    assert_eq!(llamadas.load(Ordering::SeqCst), 2, "se mira antes y después de copiar");
    assert!(vacio(&copias));
}

#[test]
fn la_revision_no_lleva_ningun_valor_de_cookie() {
    let (raiz, _dir) = perfil(
        "revision",
        &[
            fila("github.com", "sid", SECRETO_GITHUB),
            fila("google.com", "NID", SECRETO_GOOGLE),
            Fila { attrs: "^partitionKey=%28https%2Cexample.com%29", ..fila("tracker.example", "t", SECRETO_PARTICIONADO) },
        ],
    );
    let revision = review_profile(Ok(()), &raiz, "Profile0", &lugar("revision-tmp"), &cerrado, AHORA).unwrap();
    let json = serde_json::to_string(&revision).unwrap();
    for secreto in [SECRETO_GITHUB, SECRETO_GOOGLE, SECRETO_PARTICIONADO] {
        assert!(!json.contains(secreto), "la revisión no lleva valores de cookie");
    }
    assert_eq!(revision.profile_name, "default-release");
    assert_eq!(
        revision.domains,
        vec![
            DomainCount { domain: "github.com".to_string(), cookies: 1 },
            DomainCount { domain: "google.com".to_string(), cookies: 1 },
        ]
    );
    assert_eq!(revision.ignored, 1);
}

#[test]
fn solo_entran_los_dominios_marcados_y_cada_origen_recibe_lo_suyo() {
    let (raiz, _dir) = perfil(
        "marcados",
        &[
            fila("github.com", "sid", SECRETO_GITHUB),
            Fila { secure: 0, ..fila("github.com", "preferencia", SECRETO_PREF) },
            fila("google.com", "NID", SECRETO_GOOGLE),
        ],
    );
    let estado = Sitios::nuevo(lugar("marcados-estado"));
    let copias = lugar("marcados-copias");
    let resultado = apply_profile(
        Ok(()),
        &raiz,
        "Profile0",
        &["github.com".to_string()],
        &copias,
        &cerrado,
        &|origen: &str| estado.sitio(origen),
        AHORA_MS,
    )
    .unwrap();
    assert_eq!(resultado.domains, vec![DomainCount { domain: "github.com".to_string(), cookies: 2 }]);
    assert_eq!(resultado.cookies, 2);
    assert_eq!(
        estado.origenes(),
        vec!["http://github.com".to_string(), "https://github.com".to_string()],
        "google.com no se toca"
    );
    assert_eq!(estado.nombres("https://github.com", AHORA), vec!["preferencia".to_string(), "sid".to_string()]);
    assert_eq!(estado.nombres("http://github.com", AHORA), vec!["preferencia".to_string()]);
    assert!(vacio(&copias));
}

#[test]
fn los_cookies_particionados_y_de_otro_contenedor_quedan_fuera() {
    let (raiz, _dir) = perfil(
        "ignorados",
        &[
            fila("github.com", "normal", "a"),
            Fila { attrs: "^userContextId=0", ..fila("github.com", "contenedor-cero", "b") },
            Fila { attrs: "^userContextId=2", ..fila("github.com", "contenedor", SECRETO_CONTENEDOR) },
            Fila { attrs: "^firstPartyDomain=github.com", ..fila("github.com", "dfpi", "c") },
            Fila { attrs: "^partitionKey=%28https%2Cgoogle.com%29", ..fila("google.com", "particionada", SECRETO_PARTICIONADO) },
            Fila { attrs: "^privateBrowsingId=1", ..fila("github.com", "privada", "d") },
        ],
    );
    let revision = review_profile(Ok(()), &raiz, "Profile0", &lugar("ignorados-tmp"), &cerrado, AHORA).unwrap();
    assert_eq!(revision.domains, vec![DomainCount { domain: "github.com".to_string(), cookies: 2 }]);
    assert_eq!(revision.ignored, 4, "contenedor, firstParty, partición y navegación privada");
}

#[test]
fn la_sesion_y_la_expiracion_se_leen_como_el_navegador() {
    let (_raiz, dir) = perfil(
        "expiracion",
        &[
            fila("github.com", "de-sesion", "a"),
            Fila { expiry: 2_000_000_000, ..fila("github.com", "con-fecha", "b") },
            Fila { expiry: 1_000_000_000, ..fila("github.com", "vencida", "c") },
            Fila { expiry: 2_000_000_000_000, ..fila("github.com", "en-milisegundos", "d") },
        ],
    );
    let lectura = firefox::read_profile_cookies(&dir, &lugar("expiracion-tmp"), &cerrado, AHORA).unwrap();
    let por_nombre: HashMap<String, Option<i64>> =
        lectura.cookies.iter().map(|c| (c.cookie.name.clone(), c.cookie.expires_at)).collect();
    assert_eq!(por_nombre.len(), 3, "la vencida no entra");
    assert_eq!(por_nombre["de-sesion"], None);
    assert_eq!(por_nombre["con-fecha"], Some(2_000_000_000));
    assert_eq!(por_nombre["en-milisegundos"], Some(2_000_000_000), "los milisegundos se pasan a segundos");
}

#[test]
fn el_samesite_del_firefox_se_traduce_como_en_el_navegador() {
    let (_raiz, dir) = perfil(
        "samesite",
        &[
            Fila { same_site: 0, ..fila("github.com", "none", "a") },
            Fila { same_site: 1, ..fila("github.com", "lax", "b") },
            Fila { same_site: 2, ..fila("github.com", "strict", "c") },
            Fila { same_site: 256, ..fila("github.com", "sin-atributo", "d") },
        ],
    );
    let lectura = firefox::read_profile_cookies(&dir, &lugar("samesite-tmp"), &cerrado, AHORA).unwrap();
    let por_nombre: HashMap<String, Option<String>> =
        lectura.cookies.iter().map(|c| (c.cookie.name.clone(), c.cookie.same_site.clone())).collect();
    assert_eq!(por_nombre["none"], Some("None".to_string()));
    assert_eq!(por_nombre["lax"], Some("Lax".to_string()));
    assert_eq!(por_nombre["strict"], Some("Strict".to_string()));
    assert_eq!(por_nombre["sin-atributo"], None, "sin atributo no se inventa uno");
}

#[test]
fn el_dominio_se_normaliza_y_los_hosts_raros_se_descartan() {
    assert_eq!(normalize_domain(".GitHub.com").as_deref(), Some("github.com"));
    assert_eq!(normalize_domain("127.0.0.1").as_deref(), Some("127.0.0.1"));
    for malo in ["", "bad host", "a/b", "-x.com", "x..com", "x-.com", "ñandu.com"] {
        assert_eq!(normalize_domain(malo), None, "host: {malo}");
    }
}

#[test]
fn una_cookie_segura_va_a_https_y_una_no_segura_a_los_dos() {
    assert_eq!(origins_for("github.com", true), vec!["https://github.com".to_string()]);
    assert_eq!(
        origins_for("github.com", false),
        vec!["http://github.com".to_string(), "https://github.com".to_string()]
    );
}

#[test]
fn sin_archivo_de_bloqueo_el_perfil_no_esta_en_uso() {
    let (_raiz, dir) = perfil("sin-bloqueo", &[]);
    assert_eq!(firefox::profile_in_use(&dir), Ok(false));
}

#[test]
fn un_archivo_de_bloqueo_que_nadie_sostiene_no_cuenta_como_abierto_y_no_se_altera() {
    let (_raiz, dir) = perfil("bloqueo-libre", &[]);
    std::fs::write(dir.join("parent.lock"), b"").unwrap();
    std::fs::write(dir.join(".parentlock"), b"").unwrap();
    let antes = retrato(&dir);
    assert_eq!(firefox::profile_in_use(&dir), Ok(false));
    assert_eq!(retrato(&dir), antes, "mirar el bloqueo no lo altera");
}

#[test]
fn sin_clave_del_keyring_la_importacion_se_recusa_con_la_razon_y_no_se_lee_nada() {
    let (raiz, dir) = perfil("sin-clave", &[fila("github.com", "sid", SECRETO_GITHUB)]);
    let copias = lugar("sin-clave-copias");
    let estado = lugar("sin-clave-estado");
    let antes = retrato(&dir);
    let sin_clave: Result<(), ImportError> =
        Err(ImportError::new("no-state-key").with("o chaveiro do sistema não está disponível"));
    let error = apply_profile(
        sin_clave.clone(),
        &raiz,
        "Profile0",
        &["github.com".to_string()],
        &copias,
        &cerrado,
        &|_origen: &str| -> Arc<Site> { panic!("ningún sitio debe abrirse sin clave") },
        AHORA_MS,
    )
    .err()
    .unwrap();
    assert_eq!(error.code, "no-state-key");
    assert_eq!(error.detail.as_deref(), Some("o chaveiro do sistema não está disponível"));
    assert!(vacio(&copias), "no se copia nada");
    assert!(vacio(&estado), "no se escribe nada");
    assert_eq!(retrato(&dir), antes, "el perfil ni se abre");
    let revision = review_profile(sin_clave, &raiz, "Profile0", &copias, &cerrado, AHORA).err().unwrap();
    assert_eq!(revision.code, "no-state-key");
}

#[test]
fn lo_que_queda_en_disco_va_cifrado_y_la_copia_temporal_se_borra() {
    let (raiz, _dir) = perfil(
        "disco",
        &[
            fila("github.com", "sid", SECRETO_GITHUB),
            Fila { secure: 0, ..fila("github.com", "preferencia", SECRETO_PREF) },
        ],
    );
    let estado_dir = lugar("disco-estado");
    let copias = lugar("disco-copias");
    let estado = Sitios::nuevo(estado_dir.clone());
    apply_profile(
        Ok(()),
        &raiz,
        "Profile0",
        &["github.com".to_string()],
        &copias,
        &cerrado,
        &|origen: &str| estado.sitio(origen),
        AHORA_MS,
    )
    .unwrap();
    // Un sitio abierto después, con la misma clave, lee las mismas cookies desde el archivo cifrado.
    let reabierto = Site::open("https://github.com", Some(estado_dir.as_path()), Some(estado.clave.clone()));
    assert_eq!(reabierto.cookies(AHORA).len(), 2, "lo guardado vuelve a leerse");
    let mut archivos = 0;
    for entrada in std::fs::read_dir(&estado_dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let bytes = std::fs::read(&ruta).unwrap();
        assert!(bytes.starts_with(b"ADESITE1"), "{}: archivo cifrado", ruta.display());
        assert!(!contiene(&bytes, SECRETO_GITHUB) && !contiene(&bytes, SECRETO_PREF), "no hay valores en claro");
        archivos += 1;
    }
    assert_eq!(archivos, 2, "un archivo por origen: https e http");
    assert!(vacio(&copias), "la copia temporal se borra");
}

#[test]
fn una_cookie_que_todavia_esta_en_el_wal_tambien_se_lee() {
    let raiz = lugar("wal");
    let dir = raiz.join("Profiles").join("abc.default-release");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(raiz.join("profiles.ini"), INI).unwrap();
    // El Firefox escribe en WAL: si se cerró mal, las filas quedan en `cookies.sqlite-wal`.
    let conn = Connection::open(dir.join("cookies.sqlite")).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(ESQUEMA).unwrap();
    insertar(&conn, &[fila("github.com", "sid", SECRETO_GITHUB)]);
    assert!(dir.join("cookies.sqlite-wal").is_file(), "la prueba necesita el WAL todavía presente");
    let antes = retrato(&dir);
    let lectura = firefox::read_profile_cookies(&dir, &lugar("wal-copias"), &cerrado, AHORA).unwrap();
    assert_eq!(lectura.cookies.len(), 1, "la fila que solo está en el WAL también entra");
    assert_eq!(retrato(&dir), antes, "el original y su WAL no cambian");
    drop(conn);
}

#[test]
fn sin_dominios_marcados_o_con_uno_que_ya_no_existe_no_se_importa_nada() {
    let (raiz, _dir) = perfil("nada", &[fila("github.com", "sid", SECRETO_GITHUB)]);
    let estado = Sitios::nuevo(lugar("nada-estado"));
    for marcados in [vec![], vec!["ya-no-existe.com".to_string()]] {
        let error = apply_profile(
            Ok(()),
            &raiz,
            "Profile0",
            &marcados,
            &lugar("nada-copias"),
            &cerrado,
            &|origen: &str| estado.sitio(origen),
            AHORA_MS,
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "no-domains");
    }
    assert!(estado.origenes().is_empty());
}
