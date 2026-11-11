//! Testes da importação de Chromium, Safari e Zen, e do perfil de destino. Só fixtures sintéticas:
//! o banco de cookies do Chromium é cifrado aqui com uma chave de teste e o `Cookies.binarycookies` é montado
//! byte a byte. Nenhum perfil, cookie, chave ou Keychain real é lido, e o Keychain nunca é consultado
//! (o provedor de chave é sempre injetado).

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aes::Aes128;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};
use ring::{aead, digest};
use rusqlite::{params, Connection};

use super::chromium::{self, Keys};
use super::copy;
use super::safari;
use super::sources::{self, Context, Platform};
use super::test::{abierto, cerrado, contiene, lugar, retrato, vacio, Sitios, AHORA, AHORA_MS};
use super::{apply_source, review_source, valid_target_profile, Env, ImportError};
use crate::preview::site::Site;

/// A "senha do Keychain" desta suíte. Não é de nenhum navegador real.
const SENHA_TESTE: &[u8] = b"senha-de-teste-que-nao-e-real";
const SEGREDO_GITHUB: &str = "chromium-github-SEGREDO-4a4a";
const SEGREDO_GOOGLE: &str = "chromium-google-SEGREDO-9c9c";
const SEGREDO_PARTICIONADO: &str = "particionado-SEGREDO-1d1d";
const SEGREDO_SAFARI: &str = "safari-SEGREDO-7e7e";

fn chaves_teste() -> Keys {
    chromium::mac_keys(SENHA_TESTE)
}

/// Cifra como o OSCrypt do macOS: `v10` + AES-128-CBC com IV de 16 espaços.
fn cifrar_cbc(claro: &[u8], chave: &[u8; 16]) -> Vec<u8> {
    let mut buffer = vec![0u8; claro.len() + 16];
    buffer[..claro.len()].copy_from_slice(claro);
    let cifrado = cbc::Encryptor::<Aes128>::new_from_slices(chave, &[0x20; 16]).unwrap().encrypt_padded_mut::<Pkcs7>(&mut buffer, claro.len()).unwrap();
    [b"v10".as_slice(), cifrado].concat()
}

/// O valor como o Chromium 127+ (esquema >= 24) o guarda: SHA-256 do `host_key` na frente do valor.
fn com_hash_do_dominio(host_key: &str, valor: &str) -> Vec<u8> {
    [digest::digest(&digest::SHA256, host_key.as_bytes()).as_ref(), valor.as_bytes()].concat()
}

/// Microssegundos desde 1601, como `expires_utc`. 0 = sessão.
fn webkit(unix_secs: i64) -> i64 {
    (unix_secs + 11_644_473_600) * 1_000_000
}

struct FilaC {
    host: &'static str,
    top_frame: &'static str,
    name: &'static str,
    value: &'static str,
    encrypted: Vec<u8>,
    expires: i64,
    secure: i64,
    same_site: i64,
}

fn fila_c(host: &'static str, name: &'static str, encrypted: Vec<u8>) -> FilaC {
    FilaC { host, top_frame: "", name, value: "", encrypted, expires: webkit(AHORA + 86_400), secure: 1, same_site: -1 }
}

const ESQUEMA_CHROMIUM: &str = "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);\
CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, samesite INTEGER NOT NULL)";

/// Um navegador Chromium sintético no macOS: `Local State`, `Default/Network/Cookies` e a raiz.
/// Devolve (contexto do sistema, caminho do banco de cookies).
fn chromium_sintetico(tag: &str, versao: i64, filas: &[FilaC]) -> (Context, PathBuf) {
    let base = lugar(tag);
    let raiz = base.join("data").join("Google").join("Chrome");
    let perfil = raiz.join("Default");
    std::fs::create_dir_all(perfil.join("Network")).unwrap();
    std::fs::write(raiz.join("Local State"), r#"{"profile":{"info_cache":{"Default":{"name":"Pessoa"},"Profile 1":{"name":"Trabalho"},"../fuga":{"name":"ruim"}}}}"#).unwrap();
    let db = perfil.join("Network").join("Cookies");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(ESQUEMA_CHROMIUM).unwrap();
    conn.execute("INSERT INTO meta (key, value) VALUES ('version', ?1)", params![versao.to_string()]).unwrap();
    for f in filas {
        conn.execute(
            "INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) VALUES (0, ?1, ?2, ?3, ?4, ?5, '/', ?6, ?7, 1, ?8)",
            params![f.host, f.top_frame, f.name, f.value, f.encrypted, f.expires, f.secure, f.same_site],
        )
        .unwrap();
    }
    drop(conn);
    let ctx = Context { platform: Platform::Mac, home: Some(base.join("home")), data: Some(base.join("data")), local: None, config: None, chrome_config: None };
    (ctx, db)
}

fn filas_normais() -> Vec<FilaC> {
    let chave = chaves_teste().cbc_v10.unwrap();
    vec![
        fila_c(".github.com", "sid", cifrar_cbc(&com_hash_do_dominio(".github.com", SEGREDO_GITHUB), &chave)),
        FilaC { same_site: 1, ..fila_c(".google.com", "SID", cifrar_cbc(&com_hash_do_dominio(".google.com", SEGREDO_GOOGLE), &chave)) },
        FilaC { top_frame: "https://outro.com", ..fila_c(".google.com", "particionado", cifrar_cbc(&com_hash_do_dominio(".google.com", SEGREDO_PARTICIONADO), &chave)) },
        FilaC { expires: webkit(AHORA - 10), ..fila_c(".github.com", "vencido", cifrar_cbc(&com_hash_do_dominio(".github.com", "vencido"), &chave)) },
    ]
}

/// Tudo o que a leitura precisa, com a chave injetada e contagem de quantas vezes foi pedida.
struct Mundo {
    tmp: PathBuf,
    pedidas: Cell<usize>,
}

impl Mundo {
    fn novo(tag: &str) -> Self {
        Self { tmp: lugar(tag), pedidas: Cell::new(0) }
    }
}

fn revisar(mundo: &Mundo, ctx: &Context, fonte: &str, perfil: &str) -> Result<super::ImportReview, ImportError> {
    let pedir = |_: &sources::Source, _: &Context| -> Result<Keys, ImportError> { panic!("a revisão nunca pede a chave") };
    let env = Env { ctx, tmp_root: &mundo.tmp, in_use: &cerrado, keys: &pedir };
    review_source(Ok(()), &env, fonte, perfil, AHORA)
}

fn gravar(mundo: &Mundo, ctx: &Context, fonte: &str, perfil: &str, dominios: &[&str], sitios: &Sitios, chaves: &dyn Fn() -> Result<Keys, ImportError>) -> Result<super::ImportOutcome, ImportError> {
    gravar_com(mundo, ctx, fonte, perfil, dominios, sitios, chaves, &cerrado)
}

// A lista de argumentos espelha o `Env` e o pedido de gravação: agrupar só esconderia o que cada teste varia.
#[allow(clippy::too_many_arguments)]
fn gravar_com(mundo: &Mundo, ctx: &Context, fonte: &str, perfil: &str, dominios: &[&str], sitios: &Sitios, chaves: &dyn Fn() -> Result<Keys, ImportError>, em_uso: &dyn Fn(&Path) -> Result<bool, String>) -> Result<super::ImportOutcome, ImportError> {
    let pedir = |_: &sources::Source, _: &Context| -> Result<Keys, ImportError> {
        mundo.pedidas.set(mundo.pedidas.get() + 1);
        chaves()
    };
    let env = Env { ctx, tmp_root: &mundo.tmp, in_use: em_uso, keys: &pedir };
    let dominios: Vec<String> = dominios.iter().map(|d| d.to_string()).collect();
    apply_source(Ok(()), &env, fonte, perfil, &dominios, &|origem: &str| -> Arc<Site> { sitios.sitio(origem) }, AHORA_MS)
}

// ───────────────────────── Chromium ─────────────────────────

#[test]
fn a_chave_pbkdf2_do_oscrypt_bate_com_o_vetor_conhecido_do_chromium() {
    // O Chromium no Linux (senha "peanuts", 1 iteração) deriva esta chave: é o vetor público do OSCrypt.
    let chave = chromium::derive_cbc_key(b"peanuts", 1);
    let hex: String = chave.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "fd621fe5a2b402539dfa147ca9272778");
}

#[test]
fn a_revisao_do_chromium_conta_dominios_sem_pedir_a_chave_e_sem_valores() {
    let (ctx, _db) = chromium_sintetico("c-revisao", 24, &filas_normais());
    let mundo = Mundo::novo("c-revisao-tmp");
    let revisao = revisar(&mundo, &ctx, "chrome", "Default").unwrap();
    assert_eq!(revisao.profile_name, "Pessoa");
    let dominios: Vec<(&str, usize)> = revisao.domains.iter().map(|d| (d.domain.as_str(), d.cookies)).collect();
    assert_eq!(dominios, vec![("github.com", 1), ("google.com", 1)], "vencido sai, particionado não conta como domínio");
    assert_eq!(revisao.ignored, 1, "o particionado fica de fora e é contado");
    let json = serde_json::to_string(&revisao).unwrap();
    assert!(!json.contains(SEGREDO_GITHUB) && !json.contains(SEGREDO_GOOGLE), "nenhum valor na revisão");
    assert!(vacio(&mundo.tmp), "a cópia temporária se apaga");
}

#[test]
fn decifra_v10_cbc_com_o_hash_do_dominio_e_grava_so_os_marcados_cifrado_no_estado() {
    let (ctx, db) = chromium_sintetico("c-grava", 24, &filas_normais());
    let antes = retrato(db.parent().unwrap());
    let mundo = Mundo::novo("c-grava-tmp");
    let estado_dir = lugar("c-grava-estado");
    let sitios = Sitios::nuevo(estado_dir.clone());
    let resultado = gravar(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| Ok(chaves_teste())).unwrap();
    assert_eq!(resultado.cookies, 1);
    assert_eq!(resultado.skipped, 0);
    assert_eq!(mundo.pedidas.get(), 1, "a chave é pedida uma vez, só ao gravar");
    assert_eq!(sitios.origenes(), vec!["https://github.com".to_string()], "só o domínio marcado, só https (cookie seguro)");
    let guardada = sitios.sitio("https://github.com").cookies(AHORA);
    assert_eq!(guardada.len(), 1);
    assert_eq!(guardada[0].name, "sid");
    assert_eq!(guardada[0].value, SEGREDO_GITHUB, "o valor decifrado chega ao estado");
    assert_eq!(retrato(db.parent().unwrap()), antes, "o banco original não muda");
    // No disco, só cifrado.
    for entrada in std::fs::read_dir(&estado_dir).unwrap() {
        let bytes = std::fs::read(entrada.unwrap().path()).unwrap();
        assert!(bytes.starts_with(b"ADESITE1") && !contiene(&bytes, SEGREDO_GITHUB) && !contiene(&bytes, SEGREDO_GOOGLE));
    }
    assert!(vacio(&mundo.tmp));
}

#[test]
fn esquema_anterior_ao_24_nao_tem_o_prefixo_do_hash() {
    let chave = chaves_teste().cbc_v10.unwrap();
    let filas = vec![fila_c(".github.com", "sid", cifrar_cbc(SEGREDO_GITHUB.as_bytes(), &chave))];
    let (ctx, _db) = chromium_sintetico("c-v23", 23, &filas);
    let mundo = Mundo::novo("c-v23-tmp");
    let sitios = Sitios::nuevo(lugar("c-v23-estado"));
    gravar(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| Ok(chaves_teste())).unwrap();
    assert_eq!(sitios.sitio("https://github.com").cookies(AHORA)[0].value, SEGREDO_GITHUB);
}

#[test]
fn chave_errada_recusa_com_undecryptable_e_nao_grava_nada() {
    let (ctx, _db) = chromium_sintetico("c-errada", 24, &filas_normais());
    let mundo = Mundo::novo("c-errada-tmp");
    let estado_dir = lugar("c-errada-estado");
    let sitios = Sitios::nuevo(estado_dir.clone());
    let erro = gravar(&mundo, &ctx, "chrome", "Default", &["github.com", "google.com"], &sitios, &|| Ok(chromium::mac_keys(b"outra-senha-qualquer"))).err().unwrap();
    assert_eq!(erro.code, "undecryptable");
    assert!(sitios.origenes().is_empty());
    assert!(vacio(&estado_dir), "nada gravado");
    assert!(vacio(&mundo.tmp));
}

#[test]
fn linhas_v11_e_v20_ficam_de_fora_e_contam_como_puladas_sem_derrubar_as_boas() {
    let chave = chaves_teste().cbc_v10.unwrap();
    let mut filas = vec![fila_c(".github.com", "boa", cifrar_cbc(&com_hash_do_dominio(".github.com", SEGREDO_GITHUB), &chave))];
    filas.push(fila_c(".github.com", "v11", [b"v11".as_slice(), &[7u8; 32]].concat()));
    filas.push(fila_c(".github.com", "v20", [b"v20".as_slice(), &[9u8; 32]].concat()));
    let (ctx, _db) = chromium_sintetico("c-pulos", 24, &filas);
    let mundo = Mundo::novo("c-pulos-tmp");
    let sitios = Sitios::nuevo(lugar("c-pulos-estado"));
    let resultado = gravar(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| Ok(chaves_teste())).unwrap();
    assert_eq!((resultado.cookies, resultado.skipped), (1, 2));
}

#[test]
fn o_valor_em_claro_da_coluna_value_serve_quando_nao_ha_encrypted_value() {
    let filas = vec![FilaC { value: "plano-ok", ..fila_c(".github.com", "antigo", Vec::new()) }];
    let (ctx, _db) = chromium_sintetico("c-claro", 24, &filas);
    let mundo = Mundo::novo("c-claro-tmp");
    let sitios = Sitios::nuevo(lugar("c-claro-estado"));
    gravar(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| Ok(chaves_teste())).unwrap();
    assert_eq!(sitios.sitio("https://github.com").cookies(AHORA)[0].value, "plano-ok");
}

#[test]
fn samesite_expiracao_e_sessao_do_chromium_se_traduzem() {
    let (ctx, _db) = chromium_sintetico("c-atributos", 24, &filas_normais());
    let mundo = Mundo::novo("c-atributos-tmp");
    let sitios = Sitios::nuevo(lugar("c-atributos-estado"));
    gravar(&mundo, &ctx, "chrome", "Default", &["google.com"], &sitios, &|| Ok(chaves_teste())).unwrap();
    let cookie = &sitios.sitio("https://google.com").cookies(AHORA)[0];
    assert_eq!(cookie.same_site.as_deref(), Some("Lax"));
    assert_eq!(cookie.expires_at, Some(AHORA + 86_400), "microssegundos de 1601 viram segundos Unix");
    assert!(cookie.secure && cookie.http_only);
    let sessao = vec![FilaC { expires: 0, ..fila_c(".github.com", "sessao", cifrar_cbc(&com_hash_do_dominio(".github.com", "x"), &chaves_teste().cbc_v10.unwrap())) }];
    let (ctx, _) = chromium_sintetico("c-sessao", 24, &sessao);
    let sitios = Sitios::nuevo(lugar("c-sessao-estado"));
    gravar(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| Ok(chaves_teste())).unwrap();
    assert_eq!(sitios.sitio("https://github.com").cookies(AHORA)[0].expires_at, None, "expires_utc 0 é cookie de sessão");
}

#[test]
fn a_chave_nao_e_pedida_se_nao_ha_nada_a_decifrar() {
    let (ctx, _db) = chromium_sintetico("c-sem-nada", 24, &filas_normais());
    let mundo = Mundo::novo("c-sem-nada-tmp");
    let sitios = Sitios::nuevo(lugar("c-sem-nada-estado"));
    let erro = gravar(&mundo, &ctx, "chrome", "Default", &["ya-no-existe.com"], &sitios, &|| Ok(chaves_teste())).err().unwrap();
    assert_eq!(erro.code, "no-domains");
    assert_eq!(mundo.pedidas.get(), 0, "sem domínio a gravar, o Keychain não é consultado");
}

#[test]
fn a_recusa_do_keychain_chega_com_o_codigo_certo_e_nada_e_gravado() {
    let (ctx, _db) = chromium_sintetico("c-keychain", 24, &filas_normais());
    for (codigo, razao) in [("needs-keychain-approval", ImportError::new("needs-keychain-approval")), ("keychain-item-missing", ImportError::new("keychain-item-missing"))] {
        let mundo = Mundo::novo("c-keychain-tmp");
        let sitios = Sitios::nuevo(lugar("c-keychain-estado"));
        let erro = gravar(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| Err(razao.clone())).err().unwrap();
        assert_eq!(erro.code, codigo);
        assert!(sitios.origenes().is_empty());
    }
}

#[test]
fn erros_do_keyring_viram_item_ausente_ou_falta_de_aprovacao() {
    assert_eq!(chromium::map_keyring_error(&keyring::Error::NoEntry).code, "keychain-item-missing");
    let negado = keyring::Error::NoStorageAccess("negado pelo usuário".into());
    assert_eq!(chromium::map_keyring_error(&negado).code, "needs-keychain-approval");
    let plataforma = keyring::Error::PlatformFailure("User canceled the operation".into());
    assert_eq!(chromium::map_keyring_error(&plataforma).code, "needs-keychain-approval");
}

#[test]
fn chromium_aberto_e_recusado_antes_de_copiar_e_a_revisao_tambem() {
    let (ctx, db) = chromium_sintetico("c-aberto", 24, &filas_normais());
    let mundo = Mundo::novo("c-aberto-tmp");
    let antes = retrato(db.parent().unwrap());
    let sitios = Sitios::nuevo(lugar("c-aberto-estado"));
    let erro = gravar_com(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| Ok(chaves_teste()), &abierto).err().unwrap();
    assert_eq!(erro.code, "browser-running");
    assert_eq!(mundo.pedidas.get(), 0);
    assert!(vacio(&mundo.tmp), "nada foi copiado");
    assert_eq!(retrato(db.parent().unwrap()), antes);
}

#[test]
fn id_de_perfil_que_o_navegador_nao_declara_ou_com_travessia_e_recusado() {
    let (ctx, _db) = chromium_sintetico("c-id", 24, &filas_normais());
    let mundo = Mundo::novo("c-id-tmp");
    for ruim in ["../fuga", "..", "Profile 9", "", "/etc", "Default/../Default"] {
        assert_eq!(revisar(&mundo, &ctx, "chrome", ruim).err().unwrap().code, "no-profile", "id: {ruim:?}");
    }
    assert_eq!(revisar(&mundo, &ctx, "navegador-que-nao-existe", "Default").err().unwrap().code, "unknown-source");
}

#[test]
fn a_listagem_do_chromium_usa_os_nomes_do_local_state_e_ignora_pasta_sem_cookies_ou_insegura() {
    let (ctx, _db) = chromium_sintetico("c-lista", 24, &filas_normais());
    let tmp = lugar("c-lista-tmp");
    let fontes = sources::list(&ctx, &tmp, &|_, _| Ok(false));
    let chrome = fontes.iter().find(|f| f.id == "chrome").unwrap();
    assert_eq!(chrome.unavailable, None);
    let perfis: Vec<(&str, &str)> = chrome.profiles.iter().map(|p| (p.id.as_str(), p.name.as_str())).collect();
    assert_eq!(perfis, vec![("Default", "Pessoa")], "Profile 1 não tem banco e ../fuga é rejeitado");
    let brave = fontes.iter().find(|f| f.id == "brave").unwrap();
    assert_eq!(brave.unavailable, Some("not-installed"));
    assert!(fontes.iter().any(|f| f.id == "safari") && fontes.iter().any(|f| f.id == "zen"));
    let em_uso = sources::list(&ctx, &tmp, &|_, _| Ok(true));
    assert_eq!(em_uso.iter().find(|f| f.id == "chrome").unwrap().unavailable, Some("browser-running"));
    let incerto = sources::list(&ctx, &tmp, &|_, _| Err("sem permissão".to_string()));
    assert_eq!(incerto.iter().find(|f| f.id == "chrome").unwrap().unavailable, Some("browser-running"), "bloqueio que não se confirma conta como aberto");
}

#[test]
fn o_cookies_antigo_serve_quando_nao_ha_network_cookies() {
    let base = lugar("c-antigo");
    let raiz = base.join("data").join("Arc").join("User Data");
    std::fs::create_dir_all(raiz.join("Default")).unwrap();
    std::fs::write(raiz.join("Default").join("Cookies"), b"").unwrap();
    let ctx = Context { platform: Platform::Mac, home: None, data: Some(base.join("data")), local: None, config: None, chrome_config: None };
    let fontes = sources::list(&ctx, &lugar("c-antigo-tmp"), &|_, _| Ok(false));
    let arc = fontes.iter().find(|f| f.id == "arc").unwrap();
    assert_eq!(arc.profiles.len(), 1, "sem Local State, a varredura acha a pasta com Cookies");
}

// ───────────────────────── Windows (só a lógica pura) ─────────────────────────

fn cifrar_gcm(claro: &[u8], chave: &[u8; 32]) -> Vec<u8> {
    let nonce = [3u8; 12];
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, chave).unwrap());
    let mut buffer = claro.to_vec();
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::empty(), &mut buffer).unwrap();
    [b"v10".as_slice(), &nonce, &buffer].concat()
}

#[test]
fn windows_v10_decifra_com_aes_gcm_e_v20_amarrado_ao_app_nao() {
    let chave = [5u8; 32];
    let keys = Keys::gcm(chave);
    let dado = cifrar_gcm(&com_hash_do_dominio(".github.com", SEGREDO_GITHUB), &chave);
    assert_eq!(chromium::decrypt_value(&dado, &keys, ".github.com", 24, Platform::Windows).as_deref(), Some(SEGREDO_GITHUB));
    let errada = Keys::gcm([6u8; 32]);
    assert_eq!(chromium::decrypt_value(&dado, &errada, ".github.com", 24, Platform::Windows), None, "chave errada: a etiqueta GCM não fecha");
    let v20 = [b"v20".as_slice(), &[1u8; 40]].concat();
    assert_eq!(chromium::decrypt_value(&v20, &keys, ".github.com", 24, Platform::Windows), None, "v20 é a cifra amarrada ao app");
}

#[test]
fn local_state_do_windows_amarrado_ao_app_e_recusado_com_aviso_claro() {
    use base64::Engine;
    let embrulhada = base64::engine::general_purpose::STANDARD.encode([b"DPAPI".as_slice(), &[1, 2, 3, 4]].concat());
    let simples = format!(r#"{{"os_crypt":{{"encrypted_key":"{embrulhada}"}}}}"#);
    assert_eq!(chromium::windows_wrapped_key(&simples).unwrap(), vec![1, 2, 3, 4], "o prefixo DPAPI sai");
    let amarrada = format!(r#"{{"os_crypt":{{"encrypted_key":"{embrulhada}","app_bound_encrypted_key":"QVBQQg=="}}}}"#);
    assert_eq!(chromium::windows_wrapped_key(&amarrada).err().unwrap().code, "app-bound");
    for ruim in ["não é json", r#"{"os_crypt":{}}"#, r#"{"os_crypt":{"encrypted_key":"@@@"}}"#, r#"{"os_crypt":{"encrypted_key":"AAAA"}}"#] {
        assert_eq!(chromium::windows_wrapped_key(ruim).err().unwrap().code, "unreadable", "{ruim}");
    }
}

#[test]
fn no_windows_os_chromium_de_cifra_amarrada_aparecem_como_app_bound_e_helium_segue_disponivel() {
    let base = lugar("w-lista");
    let ctx = Context { platform: Platform::Windows, home: None, data: Some(base.join("Roaming")), local: Some(base.join("Local")), config: None, chrome_config: None };
    let fontes = sources::list(&ctx, &lugar("w-lista-tmp"), &|_, _| Ok(false));
    for id in ["chrome", "edge", "brave", "vivaldi", "opera"] {
        assert_eq!(fontes.iter().find(|f| f.id == id).unwrap().unavailable, Some("app-bound"), "{id}");
    }
    assert_eq!(fontes.iter().find(|f| f.id == "helium").unwrap().unavailable, Some("not-installed"));
    assert!(fontes.iter().all(|f| f.id != "safari" && f.id != "arc"), "Safari e Arc não existem no Windows");
    let revisao = {
        let mundo = Mundo::novo("w-rev");
        revisar(&mundo, &ctx, "chrome", "Default").err().unwrap()
    };
    assert_eq!(revisao.code, "app-bound");
}

// ───────────────────────── Linux e Windows (fixtures por plataforma) ─────────────────────────

/// Um navegador Chromium sintético com a pasta de dados no lugar que `segmentos` diz, a partir de `base`.
fn chromium_em(base: &Path, segmentos: &[&str], versao: i64, filas: &[FilaC]) -> PathBuf {
    let raiz = segmentos.iter().fold(base.to_path_buf(), |p, s| p.join(s));
    let perfil = raiz.join("Default");
    std::fs::create_dir_all(perfil.join("Network")).unwrap();
    std::fs::write(raiz.join("Local State"), r#"{"profile":{"info_cache":{"Default":{"name":"Pessoa"}}}}"#).unwrap();
    let db = perfil.join("Network").join("Cookies");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(ESQUEMA_CHROMIUM).unwrap();
    conn.execute("INSERT INTO meta (key, value) VALUES ('version', ?1)", params![versao.to_string()]).unwrap();
    for f in filas {
        conn.execute(
            "INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) VALUES (0, ?1, ?2, ?3, ?4, ?5, '/', ?6, ?7, 1, ?8)",
            params![f.host, f.top_frame, f.name, f.value, f.encrypted, f.expires, f.secure, f.same_site],
        )
        .unwrap();
    }
    db
}

fn contexto_linux(base: &Path) -> Context {
    Context { platform: Platform::Linux, home: Some(base.join("home")), data: None, local: None, config: Some(base.join("config")), chrome_config: None }
}

/// Cifra como o Chromium no Linux: `v10`/`v11` + AES-128-CBC, IV de 16 espaços, com a chave dada.
fn cifrar_linux(prefixo: &[u8; 3], claro: &[u8], chave: &[u8; 16]) -> Vec<u8> {
    [prefixo.as_slice(), &cifrar_cbc(claro, chave)[3..]].concat()
}

const SENHA_DO_COFRE: &[u8] = b"senha-do-cofre-de-teste";

fn cookie_linux(host: &'static str, nome: &'static str, valor: &str, prefixo: &[u8; 3], chave: &[u8; 16]) -> FilaC {
    fila_c(host, nome, cifrar_linux(prefixo, &com_hash_do_dominio(host, valor), chave))
}

#[test]
fn a_chave_do_linux_vem_da_senha_peanuts_com_uma_iteracao_e_a_do_cofre_abre_o_v11() {
    let so_v10 = chromium::linux_keys(None).unwrap();
    assert_eq!(so_v10.cbc_v10, Some(chromium::derive_cbc_key(b"peanuts", 1)));
    assert_eq!(so_v10.cbc_empty, Some(chromium::derive_cbc_key(b"", 1)));
    assert!(so_v10.cbc_v11.is_none() && so_v10.cbc_v11_error.is_none());
    let com_cofre = chromium::linux_keys(Some(Ok(SENHA_DO_COFRE.to_vec()))).unwrap();
    assert_eq!(com_cofre.cbc_v11, Some(chromium::derive_cbc_key(SENHA_DO_COFRE, 1)));
    assert_ne!(com_cofre.cbc_v11, com_cofre.cbc_v10);
}

#[test]
fn no_linux_v10_decifra_com_peanuts_e_v11_com_a_senha_do_cofre_ate_o_estado_cifrado() {
    let base = lugar("l-chaves");
    let peanuts = chromium::derive_cbc_key(b"peanuts", 1);
    let cofre = chromium::derive_cbc_key(SENHA_DO_COFRE, 1);
    let filas = [
        cookie_linux(".github.com", "v10", SEGREDO_GITHUB, b"v10", &peanuts),
        cookie_linux(".github.com", "v11", SEGREDO_GOOGLE, b"v11", &cofre),
    ];
    chromium_em(&base.join("config"), &["google-chrome"], 24, &filas);
    let ctx = contexto_linux(&base);
    let mundo = Mundo::novo("l-chaves-tmp");
    let sitios = Sitios::nuevo(lugar("l-chaves-estado"));
    let resultado = gravar(&mundo, &ctx, "chrome", "Default", &["github.com"], &sitios, &|| chromium::linux_keys(Some(Ok(SENHA_DO_COFRE.to_vec())))).unwrap();
    assert_eq!((resultado.cookies, resultado.skipped), (2, 0));
    let valores: Vec<String> = sitios.sitio("https://github.com").cookies(AHORA).into_iter().map(|c| c.value).collect();
    assert!(valores.contains(&SEGREDO_GITHUB.to_string()) && valores.contains(&SEGREDO_GOOGLE.to_string()));
    // Cookie seguro: só em https, nada em http.
    assert!(sitios.sitio("http://github.com").cookies(AHORA).is_empty());
}

#[test]
fn no_linux_a_senha_vazia_e_a_segunda_tentativa_do_v10_e_do_v11() {
    let vazia = chromium::derive_cbc_key(b"", 1);
    let keys = chromium::linux_keys(Some(Ok(SENHA_DO_COFRE.to_vec()))).unwrap();
    for prefixo in [b"v10", b"v11"] {
        let dado = cifrar_linux(prefixo, &com_hash_do_dominio(".github.com", SEGREDO_GITHUB), &vazia);
        assert_eq!(chromium::decrypt_value(&dado, &keys, ".github.com", 24, Platform::Linux).as_deref(), Some(SEGREDO_GITHUB), "{prefixo:?}");
    }
    // Sem a segunda tentativa (macOS), a mesma linha não abre.
    let mac = chromium::mac_keys(b"qualquer");
    let dado = cifrar_linux(b"v10", &com_hash_do_dominio(".github.com", SEGREDO_GITHUB), &vazia);
    assert_eq!(chromium::decrypt_value(&dado, &mac, ".github.com", 24, Platform::Mac), None);
}

#[test]
fn no_linux_cofre_ausente_ou_indisponivel_nao_impede_o_v10_mas_o_motivo_aparece_se_so_havia_v11() {
    let peanuts = chromium::derive_cbc_key(b"peanuts", 1);
    let cofre = chromium::derive_cbc_key(SENHA_DO_COFRE, 1);
    for motivo in ["keychain-item-missing", "keychain-unavailable"] {
        // Há v10 e v11: o v10 importa e o v11 conta como pulado.
        let base = lugar("l-sem-cofre");
        let misto = [cookie_linux(".github.com", "a", SEGREDO_GITHUB, b"v10", &peanuts), cookie_linux(".github.com", "b", SEGREDO_GOOGLE, b"v11", &cofre)];
        chromium_em(&base.join("config"), &["google-chrome"], 24, &misto);
        let mundo = Mundo::novo("l-sem-cofre-tmp");
        let sitios = Sitios::nuevo(lugar("l-sem-cofre-estado"));
        let resultado = gravar(&mundo, &contexto_linux(&base), "chrome", "Default", &["github.com"], &sitios, &|| chromium::linux_keys(Some(Err(ImportError::new(motivo))))).unwrap();
        assert_eq!((resultado.cookies, resultado.skipped), (1, 1), "{motivo}");

        // Só v11: nada decifra e o erro é o do cofre, não um genérico "undecryptable".
        let base = lugar("l-so-v11");
        chromium_em(&base.join("config"), &["google-chrome"], 24, &[cookie_linux(".github.com", "b", SEGREDO_GOOGLE, b"v11", &cofre)]);
        let mundo = Mundo::novo("l-so-v11-tmp");
        let sitios = Sitios::nuevo(lugar("l-so-v11-estado"));
        let erro = gravar(&mundo, &contexto_linux(&base), "chrome", "Default", &["github.com"], &sitios, &|| chromium::linux_keys(Some(Err(ImportError::new(motivo))))).err().unwrap();
        assert_eq!(erro.code, motivo);
        assert!(sitios.origenes().is_empty());
    }
}

#[test]
fn no_linux_recusa_ou_cancelamento_do_cofre_para_a_importacao_sem_gravar() {
    assert_eq!(chromium::linux_keys(Some(Err(ImportError::new("needs-keychain-approval")))).err().unwrap().code, "needs-keychain-approval");
    let base = lugar("l-recusa");
    let peanuts = chromium::derive_cbc_key(b"peanuts", 1);
    chromium_em(&base.join("config"), &["google-chrome"], 24, &[cookie_linux(".github.com", "a", SEGREDO_GITHUB, b"v10", &peanuts)]);
    let mundo = Mundo::novo("l-recusa-tmp");
    let sitios = Sitios::nuevo(lugar("l-recusa-estado"));
    let erro = gravar(&mundo, &contexto_linux(&base), "chrome", "Default", &["github.com"], &sitios, &|| chromium::linux_keys(Some(Err(ImportError::new("needs-keychain-approval"))))).err().unwrap();
    assert_eq!(erro.code, "needs-keychain-approval", "o v10 não vale como atalho: a pessoa negou o cofre");
    assert!(sitios.origenes().is_empty());
}

#[test]
fn a_revisao_no_linux_nao_pede_a_chave_nem_mostra_valores() {
    let base = lugar("l-revisao");
    let peanuts = chromium::derive_cbc_key(b"peanuts", 1);
    chromium_em(&base.join("config"), &["BraveSoftware", "Brave-Browser"], 24, &[cookie_linux(".github.com", "a", SEGREDO_GITHUB, b"v10", &peanuts)]);
    let mundo = Mundo::novo("l-revisao-tmp");
    let revisao = revisar(&mundo, &contexto_linux(&base), "brave", "Default").unwrap();
    assert_eq!(revisao.domains.iter().map(|d| (d.domain.as_str(), d.cookies)).collect::<Vec<_>>(), vec![("github.com", 1)]);
    assert!(!format!("{revisao:?}").contains(SEGREDO_GITHUB));
}

#[test]
fn no_linux_cada_navegador_chromium_tem_a_pasta_e_a_aplicacao_do_libsecret_do_t3() {
    let base = lugar("l-lista");
    let mut ctx = contexto_linux(&base);
    // Chrome respeita o CHROME_CONFIG_HOME; os outros, o XDG_CONFIG_HOME (aqui, `config`).
    ctx.chrome_config = Some(base.join("chrome-home"));
    let casos: [(&str, &Path, &[&str], &str); 6] = [
        ("chrome", &base.join("chrome-home"), &["google-chrome"], "chrome"),
        ("edge", &base.join("config"), &["microsoft-edge"], "msedge"),
        ("brave", &base.join("config"), &["BraveSoftware", "Brave-Browser"], "brave"),
        ("vivaldi", &base.join("config"), &["vivaldi"], "chrome"),
        ("opera", &base.join("config"), &["opera"], "opera"),
        ("helium", &base.join("config"), &["net.imput.helium"], "chromium"),
    ];
    for (id, onde, segmentos, aplicacao) in casos {
        chromium_em(onde, segmentos, 24, &[]);
        let fonte = sources::find(id).unwrap();
        assert_eq!(fonte.linux_secret, Some(aplicacao), "{id}");
        assert_eq!(fonte.root(&ctx).unwrap(), segmentos.iter().fold(onde.to_path_buf(), |p, s| p.join(s)), "{id}");
    }
    let fontes = sources::list(&ctx, &lugar("l-lista-tmp"), &|_, _| Ok(false));
    for (id, ..) in casos {
        let info = fontes.iter().find(|f| f.id == id).unwrap_or_else(|| panic!("{id} some da lista"));
        assert_eq!((info.unavailable, info.profiles.len()), (None, 1), "{id}");
    }
    assert!(fontes.iter().all(|f| f.id != "arc" && f.id != "safari"), "Arc e Safari não existem no Linux");
    // Sem CHROME_CONFIG_HOME, o Chrome volta ao config comum.
    ctx.chrome_config = None;
    assert_eq!(sources::find("chrome").unwrap().root(&ctx).unwrap(), base.join("config").join("google-chrome"));
    assert_eq!(sources::chrome_config_home(Some(PathBuf::from("relativo/fora"))), None);
    assert_eq!(sources::chrome_config_home(Some(base.join("abs"))), Some(base.join("abs")));
}

fn firefox_em(raiz: &Path, perfil_relativo: &str, ini: bool) {
    let perfil = raiz.join(perfil_relativo);
    std::fs::create_dir_all(&perfil).unwrap();
    if ini {
        std::fs::write(raiz.join("profiles.ini"), format!("[Profile0]\nName=principal\nIsRelative=1\nPath={perfil_relativo}\n")).unwrap();
    }
    let conn = Connection::open(perfil.join("cookies.sqlite")).unwrap();
    conn.execute_batch("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER DEFAULT 0)").unwrap();
    conn.execute("INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES ('sid', 'ff-valor', '.exemplo.com', '/', 0, 1, 1)", []).unwrap();
}

#[test]
fn no_linux_firefox_e_zen_olham_snap_flatpak_e_o_dot_zen_alem_da_pasta_principal() {
    let base = lugar("l-alt");
    let casa = base.join("home");
    firefox_em(&casa.join(".mozilla").join("firefox"), "aaa.default", true);
    firefox_em(&casa.join("snap").join("firefox").join("common").join(".mozilla").join("firefox"), "bbb.default", true);
    firefox_em(&base.join("config").join("zen"), "ccc.default", true);
    firefox_em(&casa.join(".zen"), "ddd.default", true);
    firefox_em(&casa.join(".var").join("app").join("app.zen_browser.zen").join("zen"), "eee.default", true);
    let ctx = contexto_linux(&base);
    let fontes = sources::list(&ctx, &lugar("l-alt-tmp"), &|_, _| Ok(false));
    let nomes = |id: &str| fontes.iter().find(|f| f.id == id).unwrap().profiles.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    // Os três `Profile0` não colidem: as raízes alternativas levam o prefixo.
    assert_eq!(nomes("firefox"), vec!["Profile0", "alt1-Profile0"]);
    assert_eq!(nomes("zen"), vec!["Profile0", "alt1-Profile0", "alt2-Profile0"]);
    // Cada um lê o seu banco, e só o que a listagem produz vale.
    let mundo = Mundo::novo("l-alt-tmp2");
    let sitios = Sitios::nuevo(lugar("l-alt-estado"));
    gravar(&mundo, &ctx, "firefox", "alt1-Profile0", &["exemplo.com"], &sitios, &|| panic!("Firefox não usa chave")).unwrap();
    assert_eq!(sitios.sitio("https://exemplo.com").cookies(AHORA)[0].value, "ff-valor");
    assert_eq!(revisar(&mundo, &ctx, "zen", "alt2-Profile0").unwrap().domains.len(), 1);
    assert_eq!(revisar(&mundo, &ctx, "firefox", "alt9-Profile0").err().unwrap().code, "no-profile");
}

#[test]
fn firefox_sem_profiles_ini_ou_com_ini_velho_varre_as_pastas_atras_de_um_banco() {
    // Linux: as pastas ficam na raiz.
    let base = lugar("l-varre");
    firefox_em(&base.join("home").join(".mozilla").join("firefox"), "solto.default", false);
    let fontes = sources::list(&contexto_linux(&base), &lugar("l-varre-tmp"), &|_, _| Ok(false));
    let firefox = fontes.iter().find(|f| f.id == "firefox").unwrap();
    assert_eq!(firefox.profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["solto.default"]);
    // macOS: em `Profiles/`; o .ini declara um perfil sem banco, então a varredura assume.
    let base = lugar("m-varre");
    let raiz = base.join("data").join("Firefox");
    firefox_em(&raiz, "Profiles/solto.default", false);
    std::fs::write(raiz.join("profiles.ini"), "[Profile0]\nName=velho\nIsRelative=1\nPath=Profiles/inexistente\n").unwrap();
    let ctx = Context { platform: Platform::Mac, home: None, data: Some(base.join("data")), local: None, config: None, chrome_config: None };
    let fontes = sources::list(&ctx, &lugar("m-varre-tmp"), &|_, _| Ok(false));
    assert_eq!(fontes.iter().find(|f| f.id == "firefox").unwrap().profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["solto.default"]);
}

fn contexto_windows(base: &Path) -> Context {
    Context { platform: Platform::Windows, home: None, data: Some(base.join("Roaming")), local: Some(base.join("Local")), config: None, chrome_config: None }
}

#[test]
fn no_windows_helium_importa_com_aes_gcm_e_a_trava_e_o_proprio_arquivo_de_cookies() {
    let base = lugar("w-helium");
    let chave = [8u8; 32];
    let filas = [fila_c(".github.com", "sid", cifrar_gcm(&com_hash_do_dominio(".github.com", SEGREDO_GITHUB), &chave))];
    let db = chromium_em(&base.join("Local"), &["imput", "Helium", "User Data"], 24, &filas);
    let ctx = contexto_windows(&base);
    let fonte = sources::find("helium").unwrap();
    let entrada = sources::find_profile(fonte, &ctx, &lugar("w-helium-tmp0"), "Default").unwrap();
    assert_eq!(entrada.cookie_db, db);
    assert_eq!(entrada.lock_target, db, "no Windows o navegador trava o próprio arquivo de cookies");
    let mundo = Mundo::novo("w-helium-tmp");
    assert_eq!(revisar(&mundo, &ctx, "helium", "Default").unwrap().domains.len(), 1);
    let sitios = Sitios::nuevo(lugar("w-helium-estado"));
    let resultado = gravar(&mundo, &ctx, "helium", "Default", &["github.com"], &sitios, &|| Ok(Keys::gcm(chave))).unwrap();
    assert_eq!(resultado.cookies, 1);
    assert_eq!(sitios.sitio("https://github.com").cookies(AHORA)[0].value, SEGREDO_GITHUB);
}

#[test]
fn no_windows_firefox_e_zen_ficam_em_appdata_roaming() {
    let base = lugar("w-ff");
    firefox_em(&base.join("Roaming").join("Mozilla").join("Firefox"), "Profiles/a.default", true);
    firefox_em(&base.join("Roaming").join("zen"), "Profiles/b.default", true);
    let fontes = sources::list(&contexto_windows(&base), &lugar("w-ff-tmp"), &|_, _| Ok(false));
    for id in ["firefox", "zen"] {
        let info = fontes.iter().find(|f| f.id == id).unwrap();
        assert_eq!((info.unavailable, info.profiles.len()), (None, 1), "{id}");
    }
    // Helium sem instalação aparece, mas como não instalado; Chrome & co. seguem como app-bound.
    assert_eq!(fontes.iter().find(|f| f.id == "helium").unwrap().unavailable, Some("not-installed"));
}

// Só compila no Linux: o mapa de erros do Secret Service (o resto do módulo precisa de um D-Bus de verdade).
#[cfg(target_os = "linux")]
#[test]
fn erros_do_secret_service_viram_os_codigos_do_helper_do_t3() {
    use secret_service::Error;
    let codigo = |e: Error| super::libsecret::map_error(&e).code;
    assert_eq!(codigo(Error::Locked), "needs-keychain-approval");
    assert_eq!(codigo(Error::Prompt), "needs-keychain-approval", "desbloqueio cancelado");
    assert_eq!(codigo(Error::NoResult), "keychain-item-missing");
    assert_eq!(codigo(Error::Unavailable), "keychain-unavailable");
    assert_eq!(codigo(Error::Crypto("falhou")), "keychain-unavailable");
}

// Só rodam no Windows (o CI do Windows só compila; rode `cargo test --lib importer` lá). Dados sintéticos.
#[cfg(windows)]
mod windows_real {
    use super::*;

    /// Embrulha uma chave sintética com o DPAPI do usuário atual (PowerShell), como o Chromium faz.
    fn embrulhar(chave: &[u8; 32]) -> Vec<u8> {
        use base64::Engine;
        let script = "Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
        let mut comando = crate::util::spawn::hidden_command("powershell.exe");
        comando.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
        let entrada = base64::engine::general_purpose::STANDARD.encode(chave).into_bytes();
        let saida = crate::util::spawn::output_with_input(&mut comando, Some(entrada), std::time::Duration::from_secs(30)).unwrap();
        assert!(saida.status.success());
        base64::engine::general_purpose::STANDARD.decode(String::from_utf8_lossy(&saida.stdout).trim()).unwrap()
    }

    #[test]
    fn o_dpapi_do_usuario_atual_devolve_a_chave_sintetica() {
        let chave = [0x42u8; 32];
        assert_eq!(chromium::unwrap_dpapi(&embrulhar(&chave)).unwrap(), chave);
        assert_eq!(chromium::unwrap_dpapi(&[1, 2, 3]).err().unwrap().code, "unreadable", "lixo não é aceito como chave");
    }

    #[test]
    fn arquivo_de_cookies_travado_sem_compartilhamento_conta_como_navegador_aberto() {
        use std::os::windows::fs::OpenOptionsExt;
        let db = lugar("w-trava").join("Cookies");
        std::fs::write(&db, b"x").unwrap();
        assert_eq!(chromium::profile_in_use(&db), Ok(false));
        let _preso = std::fs::OpenOptions::new().read(true).share_mode(0).open(&db).unwrap();
        assert_eq!(chromium::profile_in_use(&db), Ok(true));
    }
}

// ───────────────────────── Safari ─────────────────────────

/// Segundos desde 2001-01-01 (a época do Safari) para um instante Unix.
fn apple(unix_secs: i64) -> f64 {
    (unix_secs - 978_307_200) as f64
}

struct Biscoito {
    dominio: &'static str,
    nome: &'static str,
    caminho: &'static str,
    valor: &'static str,
    flags: u32,
    expira: f64,
}

fn biscoito(dominio: &'static str, nome: &'static str, valor: &'static str) -> Biscoito {
    Biscoito { dominio, nome, caminho: "/", valor, flags: 0x1 | 0x4, expira: apple(AHORA + 86_400) }
}

fn registro(c: &Biscoito) -> Vec<u8> {
    let textos = [c.dominio, c.nome, c.caminho, c.valor];
    let mut deslocamentos = [0u32; 4];
    let mut corpo = Vec::new();
    for (i, t) in textos.iter().enumerate() {
        deslocamentos[i] = (56 + corpo.len()) as u32;
        corpo.extend_from_slice(t.as_bytes());
        corpo.push(0);
    }
    let tamanho = (56 + corpo.len()) as u32;
    let mut r = Vec::new();
    r.extend_from_slice(&tamanho.to_le_bytes());
    r.extend_from_slice(&0u32.to_le_bytes());
    r.extend_from_slice(&c.flags.to_le_bytes());
    r.extend_from_slice(&0u32.to_le_bytes());
    for d in deslocamentos {
        r.extend_from_slice(&d.to_le_bytes());
    }
    r.extend_from_slice(&0u64.to_le_bytes());
    r.extend_from_slice(&c.expira.to_le_bytes());
    r.extend_from_slice(&0f64.to_le_bytes());
    assert_eq!(r.len(), 56);
    r.extend_from_slice(&corpo);
    r
}

fn pagina(cookies: &[Biscoito]) -> Vec<u8> {
    let registros: Vec<Vec<u8>> = cookies.iter().map(registro).collect();
    let mut p = vec![0, 0, 1, 0];
    p.extend_from_slice(&(cookies.len() as u32).to_le_bytes());
    let mut offset = 12 + 4 * cookies.len();
    for r in &registros {
        p.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += r.len();
    }
    p.extend_from_slice(&0u32.to_le_bytes());
    for r in &registros {
        p.extend_from_slice(r);
    }
    p
}

fn arquivo_binarycookies(paginas: &[Vec<u8>]) -> Vec<u8> {
    let mut f = b"cook".to_vec();
    f.extend_from_slice(&(paginas.len() as u32).to_be_bytes());
    for p in paginas {
        f.extend_from_slice(&(p.len() as u32).to_be_bytes());
    }
    for p in paginas {
        f.extend_from_slice(p);
    }
    f.extend_from_slice(&[0u8; 8]);
    f
}

fn jar_basico() -> Vec<u8> {
    arquivo_binarycookies(&[
        pagina(&[biscoito(".github.com", "sid", SEGREDO_SAFARI), Biscoito { flags: 0, ..biscoito("exemplo.org", "tema", "escuro") }]),
        pagina(&[Biscoito { expira: apple(AHORA - 5), ..biscoito(".github.com", "vencido", "x") }, biscoito(".google.com", "SID", "g")]),
    ])
}

#[test]
fn le_o_binarycookies_sintetico_com_paginas_flags_e_expiracao() {
    let leitura = safari::parse_binary_cookies(&jar_basico(), AHORA).unwrap();
    let nomes: Vec<&str> = leitura.cookies.iter().map(|c| c.cookie.name.as_str()).collect();
    assert_eq!(nomes, vec!["sid", "tema", "SID"], "o vencido sai e a ordem das páginas se mantém");
    let sid = &leitura.cookies[0];
    assert_eq!(sid.domain, "github.com");
    assert!(sid.secure && sid.cookie.http_only);
    assert_eq!(sid.cookie.value, SEGREDO_SAFARI);
    assert_eq!(sid.cookie.expires_at, Some(AHORA + 86_400), "segundos desde 2001 viram Unix");
    let tema = &leitura.cookies[1];
    assert!(!tema.secure && !tema.cookie.http_only);
    assert_eq!(tema.cookie.path.as_deref(), Some("/"));
}

#[test]
fn binarycookies_truncado_ou_corrompido_nunca_derruba_nem_le_alem_do_buffer() {
    let bom = jar_basico();
    // Cada prefixo do arquivo: ou lê ou recusa, nunca entra em pânico.
    for corte in 0..bom.len() {
        let _ = safari::parse_binary_cookies(&bom[..corte], AHORA);
    }
    // Cada byte trocado por 0xFF: idem.
    for i in 0..bom.len() {
        let mut ruim = bom.clone();
        ruim[i] = 0xFF;
        let _ = safari::parse_binary_cookies(&ruim, AHORA);
    }
    assert_eq!(safari::parse_binary_cookies(b"nada a ver", AHORA).err().unwrap().code, "unreadable");
    assert_eq!(safari::parse_binary_cookies(&bom[..bom.len() - 3], AHORA).err().unwrap().code, "unreadable", "rabo que não é do formato");
    assert_eq!(safari::parse_binary_cookies(b"", AHORA).err().unwrap().code, "unreadable");
}

#[test]
fn registros_de_cookie_sobrepostos_ou_com_offset_no_cabecalho_sao_recusados() {
    let mut pg = pagina(&[biscoito(".a.com", "x", "1"), biscoito(".b.com", "y", "2")]);
    // O segundo offset aponta para o mesmo registro que o primeiro.
    let primeiro: [u8; 4] = pg[8..12].try_into().unwrap();
    pg[12..16].copy_from_slice(&primeiro);
    let erro = safari::parse_binary_cookies(&arquivo_binarycookies(&[pg]), AHORA).err().unwrap();
    assert_eq!(erro.code, "unreadable");
    let mut pg = pagina(&[biscoito(".a.com", "x", "1")]);
    pg[8..12].copy_from_slice(&4u32.to_le_bytes());
    assert_eq!(safari::parse_binary_cookies(&arquivo_binarycookies(&[pg]), AHORA).err().unwrap().code, "unreadable");
}

#[test]
fn a_recusa_do_tcc_vira_needs_full_disk_access_e_a_permissao_comum_nao() {
    // O TCC do macOS nega com EPERM (1); EACCES (13) é permissão comum de arquivo.
    let tcc = std::io::Error::from_raw_os_error(1);
    assert_eq!(copy::read_error(&tcc).code, "needs-full-disk-access");
    let comum = std::io::Error::from_raw_os_error(13);
    assert_eq!(copy::read_error(&comum).code, "unreadable");
    assert!(copy::is_full_disk_access_denied(&tcc) && !copy::is_full_disk_access_denied(&comum));
}

#[cfg(unix)]
#[test]
fn arquivo_ilegivel_por_permissao_comum_nao_e_confundido_com_falta_de_acesso_total() {
    use std::os::unix::fs::PermissionsExt;
    let dir = lugar("s-perm");
    let jar = dir.join("Cookies.binarycookies");
    std::fs::write(&jar, jar_basico()).unwrap();
    std::fs::set_permissions(&jar, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Como root a permissão não vale; só confere quando o arquivo realmente ficou ilegível.
    if std::fs::File::open(&jar).is_err() {
        assert!(!safari::access_denied(&jar), "EACCES não é falta de Acesso Total ao Disco");
        assert_eq!(safari::read_cookie_file(&jar, AHORA).err().unwrap().code, "unreadable");
    }
    std::fs::set_permissions(&jar, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(!safari::access_denied(&jar));
    assert_eq!(safari::read_cookie_file(&jar, AHORA).unwrap().cookies.len(), 3);
}

fn safari_sintetico(tag: &str, com_perfil_nomeado: bool) -> Context {
    let base = lugar(tag);
    let biblioteca = base.join("home").join("Library").join("Containers").join("com.apple.Safari").join("Data").join("Library");
    std::fs::create_dir_all(biblioteca.join("Cookies")).unwrap();
    std::fs::write(biblioteca.join("Cookies").join("Cookies.binarycookies"), jar_basico()).unwrap();
    if com_perfil_nomeado {
        let uuid = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0";
        let loja = biblioteca.join("WebKit").join("WebsiteDataStore").join(uuid.to_lowercase()).join("Cookies");
        std::fs::create_dir_all(&loja).unwrap();
        std::fs::write(loja.join("Cookies.binarycookies"), arquivo_binarycookies(&[pagina(&[biscoito(".trabalho.com", "t", "1")])])).unwrap();
        std::fs::create_dir_all(biblioteca.join("Safari")).unwrap();
        let conn = Connection::open(biblioteca.join("Safari").join("SafariTabs.db")).unwrap();
        conn.execute_batch("CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, title TEXT, external_uuid TEXT, parent INTEGER, type INTEGER, subtype INTEGER, deleted INTEGER, order_index INTEGER)").unwrap();
        conn.execute("INSERT INTO bookmarks (title, external_uuid, parent, type, subtype, deleted, order_index) VALUES ('Pessoal', 'DefaultProfile', 0, 1, 2, 0, 0)", []).unwrap();
        conn.execute("INSERT INTO bookmarks (title, external_uuid, parent, type, subtype, deleted, order_index) VALUES ('Trabalho', ?1, 0, 1, 2, 0, 1)", params![uuid]).unwrap();
        conn.execute("INSERT INTO bookmarks (title, external_uuid, parent, type, subtype, deleted, order_index) VALUES ('Apagado', '11111111-2222-3333-4444-555555555555', 0, 1, 2, 1, 2)", []).unwrap();
    }
    Context { platform: Platform::Mac, home: Some(base.join("home")), data: Some(base.join("data")), local: None, config: None, chrome_config: None }
}

#[test]
fn a_listagem_do_safari_traz_o_perfil_padrao_e_os_nomeados_declarados() {
    let ctx = safari_sintetico("s-lista", true);
    let tmp = lugar("s-lista-tmp");
    let fontes = sources::list(&ctx, &tmp, &|_, _| Ok(false));
    let safari = fontes.iter().find(|f| f.id == "safari").unwrap();
    assert_eq!(safari.unavailable, None);
    let perfis: Vec<(&str, &str)> = safari.profiles.iter().map(|p| (p.id.as_str(), p.name.as_str())).collect();
    assert_eq!(perfis, vec![("default", "Pessoal"), ("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "Trabalho")], "o apagado não ressuscita");
    assert!(vacio(&tmp), "a cópia do SafariTabs.db se apaga");
}

#[test]
fn sem_safari_instalado_a_fonte_aparece_como_nao_instalada() {
    let base = lugar("s-nada");
    let ctx = Context { platform: Platform::Mac, home: Some(base), data: None, local: None, config: None, chrome_config: None };
    let fontes = sources::list(&ctx, &lugar("s-nada-tmp"), &|_, _| Ok(false));
    assert_eq!(fontes.iter().find(|f| f.id == "safari").unwrap().unavailable, Some("not-installed"));
}

#[test]
fn safari_revisa_e_grava_so_os_dominios_marcados_sem_pedir_chave() {
    let ctx = safari_sintetico("s-grava", true);
    let mundo = Mundo::novo("s-grava-tmp");
    let revisao = revisar(&mundo, &ctx, "safari", "default").unwrap();
    assert_eq!(revisao.profile_name, "Pessoal");
    let dominios: Vec<&str> = revisao.domains.iter().map(|d| d.domain.as_str()).collect();
    assert_eq!(dominios, vec!["exemplo.org", "github.com", "google.com"]);
    let estado_dir = lugar("s-grava-estado");
    let sitios = Sitios::nuevo(estado_dir.clone());
    let resultado = gravar(&mundo, &ctx, "safari", "default", &["github.com"], &sitios, &|| panic!("Safari não usa chave")).unwrap();
    assert_eq!(resultado.cookies, 1);
    assert_eq!(sitios.sitio("https://github.com").cookies(AHORA)[0].value, SEGREDO_SAFARI);
    for entrada in std::fs::read_dir(&estado_dir).unwrap() {
        let bytes = std::fs::read(entrada.unwrap().path()).unwrap();
        assert!(bytes.starts_with(b"ADESITE1") && !contiene(&bytes, SEGREDO_SAFARI));
    }
    // O perfil nomeado tem o seu próprio jar.
    let trabalho = revisar(&mundo, &ctx, "safari", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0").unwrap();
    assert_eq!(trabalho.domains.iter().map(|d| d.domain.as_str()).collect::<Vec<_>>(), vec!["trabalho.com"]);
}

// ───────────────────────── Zen (Firefox) e destino ─────────────────────────

#[test]
fn zen_usa_o_formato_do_firefox_na_sua_pasta() {
    let base = lugar("z-zen");
    let raiz = base.join("data").join("zen");
    let perfil = raiz.join("Profiles").join("x.default");
    std::fs::create_dir_all(&perfil).unwrap();
    std::fs::write(raiz.join("profiles.ini"), "[Profile0]\nName=Zen principal\nIsRelative=1\nPath=Profiles/x.default\n").unwrap();
    let conn = Connection::open(perfil.join("cookies.sqlite")).unwrap();
    conn.execute_batch("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER DEFAULT 0)").unwrap();
    conn.execute("INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES ('sid', 'zen-valor', '.exemplo.com', '/', 0, 1, 1)", []).unwrap();
    drop(conn);
    let ctx = Context { platform: Platform::Mac, home: None, data: Some(base.join("data")), local: None, config: None, chrome_config: None };
    let mundo = Mundo::novo("z-zen-tmp");
    let revisao = revisar(&mundo, &ctx, "zen", "Profile0").unwrap();
    assert_eq!(revisao.profile_name, "Zen principal");
    let sitios = Sitios::nuevo(lugar("z-zen-estado"));
    gravar(&mundo, &ctx, "zen", "Profile0", &["exemplo.com"], &sitios, &|| panic!("Firefox não usa chave")).unwrap();
    assert_eq!(sitios.sitio("https://exemplo.com").cookies(AHORA)[0].value, "zen-valor");
}

#[test]
fn profiles_ini_com_caminho_relativo_que_escapa_da_pasta_e_ignorado() {
    let raiz = lugar("z-escape");
    std::fs::write(raiz.join("profiles.ini"), "[Profile0]\nName=fuga\nIsRelative=1\nPath=../../outro\n\n[Profile1]\nName=ok\nIsRelative=1\nPath=Profiles/ok\n").unwrap();
    let nomes: Vec<String> = super::firefox::profiles(&raiz).unwrap().into_iter().map(|p| p.name).collect();
    assert_eq!(nomes, vec!["ok".to_string()]);
}

#[test]
fn so_o_perfil_padrao_e_os_nomeados_da_ada_recebem_importacao() {
    assert!(valid_target_profile("default"));
    assert!(valid_target_profile("profile-11111111-1111-4111-8111-111111111111"));
    for ruim in ["incognito", "agent-tab-0123456789abcdef", "", "profile-", "profile-curto", "../default", "profile-11111111-1111-4111-8111-11111111111g", "Default"] {
        assert!(!valid_target_profile(ruim), "{ruim:?}");
    }
}

#[test]
fn o_destino_escolhido_decide_em_que_jar_cada_origem_cai() {
    let ctx = safari_sintetico("d-destino", false);
    let mundo = Mundo::novo("d-destino-tmp");
    let padrao = Sitios::nuevo(lugar("d-padrao"));
    let nomeado = Sitios::nuevo(lugar("d-nomeado"));
    gravar(&mundo, &ctx, "safari", "default", &["github.com"], &nomeado, &|| panic!()).unwrap();
    assert!(padrao.origenes().is_empty(), "o perfil padrão não recebe o que foi para o nomeado");
    assert_eq!(nomeado.origenes(), vec!["https://github.com".to_string()]);
}
