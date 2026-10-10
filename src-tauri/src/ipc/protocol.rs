//! Protocolo compartido entre la app y la CLI `ade-ags`.
//!
//! Transporte: una línea JSON por request y una por response.
//!
//! Hay dos canales. El TCP en loopback sigue siendo el que anuncia que la app está
//! viva y el que entiende una CLI vieja: cualquier proceso local puede *conectarse*,
//! así que la autorización de siempre es el token del handshake, legible solo por el
//! usuario. Ese canal no dice quién es el proceso del otro lado.
//!
//! Memoria y swarm necesitan ese proceso. Cuando el handshake trae `socket`, la CLI
//! usa un socket Unix (Linux `SO_PEERCRED`, macOS `LOCAL_PEERPID`) o un named pipe
//! de Windows (`GetNamedPipeClientProcessId`). Sin ese campo, la CLI queda en el TCP
//! y esos comandos se rechazan: no hay PID que comprobar.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Archivo donde la app publica cómo alcanzarla. La CLI lo lee para conectarse cuando no
/// la lanzó ninguna instancia en particular (una terminal cualquiera del sistema).
pub fn handshake_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ags")
        .join("ipc.json")
}

/// La variable con la que cada instancia les dice a sus hijos —las TUIs de sus tabs, las
/// tareas de la flota y, a través de ellos, los puentes `ags mcp`— cuál es SU handshake.
///
/// Existe porque el archivo global es uno solo: con dos instancias abiertas (la app abierta
/// dos veces, un `tauri dev` al lado de la instalada, el reinicio de una actualización) la
/// última en arrancar lo pisaba, y la primera en cerrarse lo borraba. Desde ahí los agentes
/// de la que seguía abierta recibían "ADE AGS no parece estar corriendo" hablando
/// desde adentro de la app.
pub const HANDSHAKE_ENV: &str = "AGS_HANDSHAKE";

/// El handshake propio de la instancia con ese PID.
pub fn instance_handshake_path(pid: u32) -> PathBuf {
    handshake_path().with_file_name("ipc").join(format!("{pid}.json"))
}

/// Onde a CLI conecta para que o servidor leia o PID dela.
///
/// No Unix é um arquivo de socket ao lado do handshake. No Windows é o nome
/// de um pipe local (`\\.\pipe\ags-ipc-<pid>`), que não é caminho de disco.
pub fn credential_endpoint(pid: u32) -> String {
    #[cfg(unix)]
    {
        instance_handshake_path(pid).with_extension("sock").to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\ags-ipc-{pid}")
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        String::new()
    }
}

/// El handshake que tiene que usar la CLI: el de la instancia que la lanzó si existe, si no
/// el global. Si esa instancia se cerró, el global lleva a la que esté abierta ahora.
pub fn client_handshake_path() -> PathBuf {
    // CONTROLCODE_HANDSHAKE es el nombre anterior: una app vieja que siga abierta lo exporta así.
    std::env::var_os(HANDSHAKE_ENV)
        .or_else(|| std::env::var_os("CONTROLCODE_HANDSHAKE"))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(|| global_handshake_for_client(handshake_path()))
}

/// Dónde buscar el handshake global desde la CLI. En el sandbox de Codex para Windows el
/// proceso corre como otro usuario (`CodexSandboxOffline`): la API de carpeta personal del
/// sistema devuelve la de ESE usuario, donde no hay nada, aunque `USERPROFILE` conserve la de
/// quien abrió la app (y el archivo se pueda leer). Si el sitio habitual no tiene el archivo,
/// se prueban esas variables; si ninguna lo tiene, se devuelve el habitual para que el error
/// diga dónde se buscó.
fn global_handshake_for_client(usual: PathBuf) -> PathBuf {
    if usual.is_file() {
        return usual;
    }
    let homes: Vec<PathBuf> = ["USERPROFILE", "HOME"].iter().filter_map(|var| std::env::var_os(var)).map(PathBuf::from).collect();
    // Primero el nombre actual de la carpeta de datos y, si una app vieja sigue abierta, el anterior.
    [".ags", ".controlcode"]
        .iter()
        .flat_map(|dir| homes.iter().map(move |home| home.join(dir).join("ipc.json")))
        .chain(dirs::home_dir().map(|h| h.join(".controlcode").join("ipc.json")))
        .find(|p| p.is_file())
        .unwrap_or(usual)
}

#[cfg(test)]
mod client_path_tests {
    use super::*;

    #[test]
    fn el_habitual_gana_si_existe() {
        let dir = std::env::temp_dir().join(format!("cc-hs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let usual = dir.join("ipc.json");
        std::fs::write(&usual, "{}").unwrap();
        assert_eq!(global_handshake_for_client(usual.clone()), usual);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sin_nada_devuelve_el_habitual_para_que_el_error_diga_donde_busco() {
        let usual = std::env::temp_dir().join("cc-no-existe").join("ipc.json");
        let found = global_handshake_for_client(usual.clone());
        // Con USERPROFILE/HOME de esta máquina puede haber un handshake real: o es ese o el habitual.
        assert!(found == usual || found.is_file());
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Handshake {
    pub port: u16,
    pub token: String,
    /// PID de la app. La CLI lo reporta en los errores para que se note enseguida si el
    /// archivo quedó de una instancia muerta.
    pub pid: u32,
    /// Versión del protocolo. Si la CLI y la app quedaron desalineadas (por ejemplo tras
    /// actualizar la app sin reinstalar la CLI), conviene decirlo con claridad en vez de
    /// fallar de formas raras al deserializar.
    pub protocol: u32,
    /// Canal com PID do cliente. Ausente numa app antiga: a CLI usa o TCP e os
    /// comandos que exigem ancestralidade são recusados.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
}

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    pub token: String,
    /// `grupo.acción`, ej. `tab.list`, `workspace.open`.
    pub command: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(data: serde_json::Value) -> Self {
        Response { ok: true, data: Some(data), error: None }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Response { ok: false, data: None, error: Some(message.into()) }
    }
}

/// Extrae un argumento string obligatorio, con un error que nombra el que falta en vez
/// de un "invalid type" genérico.
pub fn arg_str(args: &serde_json::Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Falta o argumento --{key}"))
}

pub fn arg_str_opt(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub fn arg_u64_opt(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

/// Como `arg_u64_opt`, mas um valor que está presente e não é um inteiro não negativo é um
/// ERRO que nomeia o flag, em vez de virar "ausente" e cair no padrão em silêncio (`--lines abc`
/// devolvia 40 linhas como se nada tivesse acontecido). Ausente continua sendo `Ok(None)`.
pub fn arg_u64_checked(args: &serde_json::Value, key: &str) -> Result<Option<u64>, String> {
    match args.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
            .map(Some)
            .ok_or_else(|| format!("--{key} precisa ser um número inteiro não negativo (recebi {v})")),
    }
}

#[cfg(test)]
mod checked_tests {
    use super::arg_u64_checked;
    use serde_json::json;

    #[test]
    fn ausente_e_ok_none_numero_e_some_e_lixo_e_erro_com_o_nome_do_flag() {
        assert_eq!(arg_u64_checked(&json!({}), "lines"), Ok(None));
        assert_eq!(arg_u64_checked(&json!({"lines": 3}), "lines"), Ok(Some(3)));
        assert_eq!(arg_u64_checked(&json!({"lines": "7"}), "lines"), Ok(Some(7)));
        assert!(arg_u64_checked(&json!({"lines": "abc"}), "lines").unwrap_err().contains("--lines"));
        assert!(arg_u64_checked(&json!({"lines": "-1"}), "lines").is_err());
    }
}
