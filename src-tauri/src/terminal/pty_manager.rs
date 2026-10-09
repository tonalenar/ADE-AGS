use super::containment::ProcessGroup;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::Child + Send>,
    /// Contenedor de ciclo de vida de la tab. Matar `killer` alcanza solo al proceso que
    /// lanzamos; esto se lleva además a toda su descendencia (ver `containment`).
    /// Su `Drop` mata el grupo, así que cubre tanto el cierre explícito como la muerte
    /// natural del proceso — los dos caminos por los que una sesión sale del registry.
    group: ProcessGroup,
    /// La tab de la app a la que pertenece (`ADE_TAB_ID`), para no dejar dos terminales vivos
    /// de la misma tab. `None` en los PTYs que no son de una tab.
    tab_id: Option<String>,
    /// Token que este processo herda em `ADE_SESSION`. Sai do registro junto com o PTY.
    session_token: Option<String>,
    /// Perfil do Codex com o token, fora do argv. Some só quando o arquivo existe.
    codex_profile: Option<std::path::PathBuf>,
}

/// Scrollback de un PTY. `total_bytes` cuenta TODO lo que el proceso escribió alguna vez,
/// incluido lo que ya se recortó de `data`: es lo que permite al orquestador saber cuánta
/// salida nueva hubo desde su última lectura sin depender de offsets dentro de un buffer
/// que se mueve (ver `orchestrator::new_output_for`).
#[derive(Default)]
struct PtyBuffer {
    data: Vec<u8>,
    total_bytes: u64,
}

type PtyRegistry = Arc<Mutex<HashMap<u32, PtySession>>>;
type PtyBuffers = Arc<Mutex<HashMap<u32, PtyBuffer>>>;

/// Texto a partir de lecturas sueltas de bytes, sin partir caracteres.
///
/// Una lectura del PTY corta donde cae, y un carácter de varios bytes (acentos, emoji, las
/// cajas que dibujan las TUIs) puede quedar mitad en una y mitad en la siguiente. Decodificar
/// cada lectura por separado convertía las dos mitades en `�`. Acá los bytes de un carácter
/// incompleto al final se guardan para la próxima lectura; lo inválido de verdad sigue
/// saliendo como `�`.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let complete = complete_utf8_len(&self.pending);
        let text = String::from_utf8_lossy(&self.pending[..complete]).into_owned();
        self.pending.drain(..complete);
        text
    }

    /// Lo que quedó pendiente al cerrarse el PTY: ya no va a completarse.
    pub(crate) fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

/// Hasta dónde `bytes` se puede decodificar sin cortar un carácter que todavía puede
/// completarse: todo, salvo un comienzo de secuencia multibyte incompleto al final.
fn complete_utf8_len(bytes: &[u8]) -> usize {
    // Un carácter ocupa a lo sumo 4 bytes: solo los últimos 3 pueden ser uno a medias.
    for back in 1..=bytes.len().min(3) {
        let i = bytes.len() - back;
        let b = bytes[i];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue; // byte de continuación: el comienzo está más atrás
        }
        let needed = match b {
            0b1100_0000..=0b1101_1111 => 2,
            0b1110_0000..=0b1110_1111 => 3,
            0b1111_0000..=0b1111_0111 => 4,
            _ => return bytes.len(), // ASCII o inválido: nada que esperar
        };
        return if back < needed { i } else { bytes.len() };
    }
    bytes.len()
}

/// Tope del buffer de scrollback que se conserva por PTY, para poder reproducirlo
/// cuando una tab se mueve a otra ventana sin matar el proceso.
const MAX_BUFFER_BYTES: usize = 3 * 1024 * 1024;

/// Margen sobre `MAX_BUFFER_BYTES` que se deja acumular antes de recortar. `drain` es
/// O(tamaño del buffer) (memmove de todo lo que queda tras el hueco): sin este margen,
/// un proceso que escupe output sin parar (build, npm install) dispara ese memmove de
/// ~3MB en CADA chunk leído de 4KB una vez lleno el buffer. Recortando en lotes de
/// TRIM_MARGIN_BYTES en vez de byte a byte, el mismo trabajo se amortiza ~100x.
const TRIM_MARGIN_BYTES: usize = 512 * 1024;

lazy_static::lazy_static! {
    static ref PTY_REGISTRY: PtyRegistry = Arc::new(Mutex::new(HashMap::new()));
    static ref PTY_BUFFERS: PtyBuffers = Arc::new(Mutex::new(HashMap::new()));
    static ref PTY_COUNTER: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
}

// Los tres mutex globales guardan colecciones que no quedan a medio escribir si un
// thread panica con el lock tomado (un `insert`/`remove` en un HashMap es atómico desde
// fuera), así que envenenar el mutex no significa que el dato sea inválido. Recuperarlo
// con `into_inner` en vez de `unwrap()` evita que un único panic aislado deje TODOS los
// terminales de la app muertos en cascada — que es justo lo que pasaría al propagar el
// panic desde cada comando `pty_*`.
fn registry() -> MutexGuard<'static, HashMap<u32, PtySession>> {
    PTY_REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn live_update_tabs() -> Vec<Option<String>> {
    registry().values().map(|s|s.tab_id.clone()).collect()
}

/// Cuántos PTYs vivos hay. Para probar que algo NO abrió una terminal.
#[cfg(test)]
pub(crate) fn live_pty_count() -> usize {
    registry().len()
}

fn buffers() -> MutexGuard<'static, HashMap<u32, PtyBuffer>> {
    PTY_BUFFERS.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PtyDataPayload {
    pub data: String,
    /// Posição no fluxo do processo (bytes totais lidos até o fim deste pedaço). Com ela, quem
    /// escuta depois do início pede `pty_snapshot` e descarta o que o snapshot já trouxe, em
    /// vez de perder (ou repetir) a saída que saiu antes de o ouvinte existir. Os avisos do app
    /// (`display_notice`) não pertencem ao fluxo e vão sem posição.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<u64>,
}

/// O scrollback acumulado e o total de bytes que ele representa (a mesma régua de `end`).
#[derive(Serialize)]
pub struct PtySnapshot {
    pub data: String,
    pub total: u64,
}

/// O que o processo já escreveu, com a posição exata do fluxo em que o snapshot foi tirado.
/// Erro se o PTY já terminou (o frontend então não espera mais saída).
#[tauri::command]
pub fn pty_snapshot(id: u32) -> Result<PtySnapshot, String> {
    if !registry().contains_key(&id) {
        return Err(format!("PTY session {id} not found"));
    }
    let (bytes, total) = copy_scrollback_bytes(id).unwrap_or_default();
    Ok(PtySnapshot { data: String::from_utf8_lossy(&bytes).into_owned(), total })
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PtyExitPayload {
    pub code: i32,
}

fn append_to_buffer(id: u32, chunk: &[u8]) {
    let mut buffers = buffers();
    let buf = buffers.entry(id).or_default();
    buf.data.extend_from_slice(chunk);
    buf.total_bytes += chunk.len() as u64;
    if buf.data.len() > MAX_BUFFER_BYTES + TRIM_MARGIN_BYTES {
        let excess = buf.data.len() - MAX_BUFFER_BYTES;
        buf.data.drain(0..excess);
    }
}

/// Arma el script que ejecuta la cadena de pre-lanzamiento y termina en el agente.
///
/// El `exec` final es lo que hace que esto sea barato en unix: no lanza un hijo, sino que
/// REEMPLAZA la imagen del shell conservando su pid, sus descriptores y el entorno que los
/// pasos anteriores acaban de preparar. Así el pid que queda en el registry sigue siendo
/// el del agente, y `pty_kill`/`pty_resize` apuntan al proceso correcto.
///
/// El `&&` (y no `;`) es deliberado: si un paso falla, el agente NO arranca. Arrancar
/// fuera del entorno pedido es peor que no arrancar, y el error del shell queda escrito en
/// la terminal para que se vea qué pasó.
#[cfg(unix)]
pub(super) fn launch_script(command: &str, prelaunch: &[String]) -> String {
    format!("{} && exec {command}", prelaunch.join(" && "))
}

/// Windows no tiene `exec`: no hay forma de reemplazar la imagen de un proceso conservando
/// su pid. El agente queda sí o sí como hijo del `cmd` que lo lanza, y por eso matar la
/// tab tiene que llevarse al árbol entero — de eso se encarga el Job Object de
/// `containment`, sin el cual esta feature dejaría procesos huérfanos en cada cierre.
#[cfg(windows)]
pub(super) fn launch_script(command: &str, prelaunch: &[String]) -> String {
    format!("{} && {command}", prelaunch.join(" && "))
}

/// Parte un comando en programa + argumentos respetando comillas.
///
/// `split_whitespace` a secas rompía dos casos reales: una TUI custom instalada en una
/// ruta con espacios (`/home/u/mis tools/agente`) y cualquier flag con un valor
/// entrecomillado (`--system-prompt "hola mundo"`), que llegaba partido en pedazos.
/// No pretende ser un shell: resuelve comillas simples y dobles, que es lo que se escribe
/// en el campo de comando de un agente.
pub(super) fn split_command(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut actual = String::new();
    let mut abierta: Option<char> = None;
    let mut hubo_comillas = false;

    for c in command.chars() {
        match abierta {
            Some(q) if c == q => abierta = None,
            Some(_) => actual.push(c),
            None if c == '\'' || c == '"' => {
                abierta = Some(c);
                // `--flag=""` tiene que producir un argumento vacío, no ninguno.
                hubo_comillas = true;
            }
            None if c.is_whitespace() => {
                if !actual.is_empty() || hubo_comillas {
                    out.push(std::mem::take(&mut actual));
                    hubo_comillas = false;
                }
            }
            None => actual.push(c),
        }
    }
    if !actual.is_empty() || hubo_comillas {
        out.push(actual);
    }
    out
}

/// Arma el proceso a lanzar.
///
/// Sin pre-comandos devuelve exactamente lo de siempre: el binario con sus argumentos,
/// sin ningún intermediario. Con pre-comandos hay que delegar en un shell, porque
/// `conda activate` y compañía son funciones de shell y no programas: ejecutadas en un
/// proceso aparte, su efecto muere con él (ver el módulo `prelaunch`).
/// Las variables con que un Claude Code (o su app de escritorio) marca "esta es una sesión
/// mía": si el ADE AGS se abrió desde una, los terminales las heredan y el Claude de adentro
/// se cree sesión hija (sin guardar transcript, con el socket y la identidad del padre).
/// Se sacan de todo terminal; no se tocan las de configuración del usuario (`ANTHROPIC_*`,
/// `CLAUDE_CODE_USE_*`...) ni las de una cuenta de la app, que se aplican después.
pub(super) const PARENT_SESSION_ENV: &[&str] = &[
    // Una sesión de agente que abrió la app deja `NO_COLOR=1` en el entorno y todos los terminales
    // heredaban TUIs en blanco y negro. El color de un terminal de la app lo decide la app
    // (`TERM`/`COLORTERM` de abajo), no el entorno de quien la lanzó.
    "NO_COLOR",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_DESKTOP_APP_VERSION",
    "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
    "CLAUDE_CODE_EAGER_FLUSH",
    "CLAUDE_CODE_REPORT_FINDINGS",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_CODE_DISABLE_CRON",
];

pub(super) fn build_launch(command: &str, prelaunch: &[String]) -> Result<CommandBuilder, String> {
    if prelaunch.is_empty() {
        return direct_launch(command);
    }
    // Um shell só: `conda activate`, `nvm use`, `set VAR=` e `cd` têm que valer para
    // o agente. No Windows isso é um `.cmd` e um `cmd /C` dentro do ConPTY. A janela
    // não abre porque `win_conpty` já passou `CREATE_NO_WINDOW`: o console é o PTY.
    Ok(shell_running(launch_script(command, prelaunch)))
}

fn direct_launch(command: &str) -> Result<CommandBuilder, String> {
    let parts = split_command(command);
    let mut parts = parts.iter().map(String::as_str);
    let program = parts.next().unwrap_or(command);
    #[cfg(windows)]
    {
        let path = crate::util::find_program(program).unwrap_or_else(|| std::path::PathBuf::from(program));
        let args: Vec<_> = parts.collect();
        let native = crate::util::launch::external_command(&path, &args).map_err(|e| e.to_string())?;
        if crate::util::launch::is_batch(std::path::Path::new(native.get_program())) {
            return Err("Este script .cmd/.bat não é um shim npm reconhecido. Configure o executável ou intérprete diretamente.".into());
        }
        let mut cmd = CommandBuilder::new(native.get_program());
        cmd.args(native.get_args());
        return Ok(cmd);
    }
    #[cfg(not(windows))]
    {
        let mut cmd = CommandBuilder::new(program);
        for arg in parts {
            cmd.arg(arg);
        }
        Ok(cmd)
    }
}

/// El shell que ejecuta el script.
///
/// `$SHELL` y no `bash` fijo: quien usa zsh o fish tiene su configuración ahí, y es de
/// donde salen las funciones que estos pasos suelen invocar.
///
/// `-l` (login) hace que se lean los perfiles del sistema y del usuario. Importa porque una
/// app lanzada desde el menú del escritorio no hereda el PATH de tu shell: sin esto, un
/// `nvm use` no tendría ni nvm que invocar.
#[cfg(unix)]
fn shell_running(script: String) -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.arg("-c");
    cmd.arg(script);
    cmd
}

/// Windows: el contenido del .cmd que ejecuta el script. Pura.
#[cfg(windows)]
pub(super) fn batch_launch_contents(script: &str) -> String {
    format!("@echo off\n@chcp 65001 >nul\n{script}\n")
}

/// Windows: el script va a un .cmd y no como argumento de `cmd /C`. Al pasarlo como argumento,
/// las comillas internas se escapan como `\\"` (la regla de la línea de comandos de Windows) y
/// `cmd` las deja tal cual: `claude --mcp-config "C:\x.json"` recibía las comillas LITERALES
/// y las leía como parte de una ruta relativa ("Invalid MCP configuration"). En un archivo, `cmd`
/// ve las comillas como las escribió quien armó el comando. El nombre sale del hash del script:
/// el mismo comando reutiliza el mismo archivo y la carpeta no crece sin fin.
///
/// Este `cmd` nace dentro del pseudoconsole (`open_pty` → `win_conpty`), que ya leva
/// `CREATE_NO_WINDOW`. Não é um `Command` do helper e não abre conhost.
#[cfg(windows)]
fn shell_running(script: String) -> CommandBuilder {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    script.hash(&mut hasher);
    let dir = std::env::temp_dir().join("ags-launch");
    let file = dir.join(format!("{:016x}.cmd", hasher.finish()));
    let written = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, batch_launch_contents(&script)));
    let mut cmd = CommandBuilder::new("cmd");
    cmd.arg("/C");
    match written {
        Ok(()) => cmd.arg(file.as_os_str()),
        // Sin poder escribir el archivo se vuelve al camino anterior (las comillas pueden fallar).
        Err(_) => cmd.arg(script),
    }
    cmd
}

/// El PATH de la app con la carpeta de su propio ejecutable al final, para que `ags` (que
/// viaja al lado) se encuentre en cualquier terminal de agente aunque no se haya instalado el CLI.
/// Al final, así nunca pisa un `ags` ya instalado. `None` si no hay nada que agregar.
fn path_with_app_dir(current: &std::ffi::OsStr) -> Option<std::ffi::OsString> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    if !dir.join(if cfg!(windows) { "ags.exe" } else { "ags" }).is_file() {
        return None;
    }
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(current).collect();
    if dirs.contains(&dir) {
        return None;
    }
    dirs.push(dir);
    std::env::join_paths(dirs).ok()
}

fn shell_safe_id(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Codex corre los comandos de su agente en un sandbox que descarta las variables de entorno
/// que no conoce, `ADE_TAB_ID` incluida: sin ella `ags peers` no sabe quién pregunta. La
/// config de Codex tiene `shell_environment_policy.set`, que SÍ llega al shell del sandbox;
/// se la pasa con `-c` al lanzar. Solo si el programa es `codex` y la tab tiene id. Pura.
pub(super) fn with_codex_tab_id(command: &str, tab_id: Option<&str>) -> String {
    with_codex_identity(command, tab_id, None)
}

fn codex_stem(command: &str) -> bool {
    let trimmed = command.trim_start();
    let head_len = match trimmed.chars().next() {
        Some(q @ ('"' | '\'')) => trimmed[1..].find(q).map_or(trimmed.len(), |i| i + 2),
        _ => trimmed.find(char::is_whitespace).unwrap_or(trimmed.len()),
    };
    let program = trimmed[..head_len].trim_matches(|c| c == '"' || c == '\'');
    let file = program.rsplit(['/', '\\']).next().unwrap_or("").to_ascii_lowercase();
    let stem = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".cmd")).unwrap_or(&file);
    stem == "codex"
}

/// Como [`with_codex_tab_id`], e aponta um perfil do Codex cujo arquivo (0600)
/// contém `ADE_SESSION`. O valor do token não entra no argv: `ps` e o
/// Gerenciador de Tarefas mostram o nome do perfil, não o segredo.
///
/// `profile` é só o nome (`ags-…`), já filtrado por [`shell_safe_id`].
pub(super) fn with_codex_identity(command: &str, tab_id: Option<&str>, profile: Option<&str>) -> String {
    let tab = tab_id.filter(|value| shell_safe_id(value));
    let profile = profile.filter(|value| shell_safe_id(value));
    if tab.is_none() && profile.is_none() {
        return command.to_string();
    }
    if !codex_stem(command) {
        return command.to_string();
    }
    let trimmed = command.trim_start();
    let head_len = match trimmed.chars().next() {
        Some(q @ ('"' | '\'')) => trimmed[1..].find(q).map_or(trimmed.len(), |i| i + 2),
        _ => trimmed.find(char::is_whitespace).unwrap_or(trimmed.len()),
    };
    let (head, tail) = trimmed.split_at(head_len);
    let mut flags = String::new();
    if let Some(tab) = tab {
        if !command.contains("shell_environment_policy.set.ADE_TAB_ID") {
            flags.push_str(&format!(" -c 'shell_environment_policy.set.ADE_TAB_ID=\"{tab}\"'"));
        }
    }
    if let Some(profile) = profile {
        if !command.contains(&format!("--profile {profile}")) {
            flags.push_str(&format!(" --profile {profile}"));
        }
    }
    if flags.is_empty() {
        return command.to_string();
    }
    format!("{head}{flags}{tail}")
}

fn codex_home() -> std::path::PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
}

/// Grava `~/.codex/<nome>.config.toml` com o token, modo 0600 no Unix.
/// O argv do Codex só leva `--profile <nome>`. O sandbox lê o `set` daqui,
/// então o valor não aparece em `ps` nem no Gerenciador de Tarefas.
pub(super) fn write_codex_session_profile(name: &str, token: &str) -> Result<std::path::PathBuf, String> {
    write_codex_session_profile_at(&codex_home(), name, token)
}

pub(super) fn write_codex_session_profile_at(
    home: &std::path::Path,
    name: &str,
    token: &str,
) -> Result<std::path::PathBuf, String> {
    if !shell_safe_id(name) || !shell_safe_id(token) {
        return Err("perfil do Codex recusou um valor inseguro".into());
    }
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let dest = home.join(format!("{name}.config.toml"));
    let tmp = home.join(format!("{name}.config.toml.tmp"));
    let body = format!("[shell_environment_policy.set]\nADE_SESSION = \"{token}\"\n");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    if let Err(error) = restrict_to_user(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    #[cfg(windows)]
    if let Err(error) = restrict_to_user(&dest) {
        let _ = std::fs::remove_file(&dest);
        return Err(error);
    }
    Ok(dest)
}

#[cfg(unix)]
fn restrict_to_user(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

/// No Windows o arquivo nasce no perfil do usuário. A DACL fica protegida
/// (sem herança) e só esta conta lê e escreve. Se a API falhar, quem chama
/// apaga o arquivo.
#[cfg(windows)]
fn restrict_to_user(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE,
        SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_READ, FILE_GENERIC_WRITE};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);

    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err("não foi possível ler o token desta conta".into());
        }
        let mut needed = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            CloseHandle(token);
            return Err("não foi possível ler o SID desta conta".into());
        }
        let words = (needed as usize).div_ceil(std::mem::size_of::<usize>()).max(1);
        let mut sid_buf = vec![0usize; words];
        if GetTokenInformation(
            token,
            TokenUser,
            sid_buf.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
        {
            CloseHandle(token);
            return Err("não foi possível ler o SID desta conta".into());
        }
        CloseHandle(token);
        let sid = (*sid_buf.as_ptr().cast::<TOKEN_USER>()).User.Sid;
        if sid.is_null() {
            return Err("esta conta não tem SID".into());
        }

        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: sid.cast(),
            },
        };
        let mut acl = std::ptr::null_mut();
        let built = SetEntriesInAclW(1, &entry, std::ptr::null(), &mut acl);
        if built != 0 || acl.is_null() {
            return Err(format!("não foi possível montar a ACL ({built})"));
        }
        let applied = SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        );
        LocalFree(acl.cast());
        if applied != 0 {
            return Err(format!("não foi possível restringir o perfil ({applied})"));
        }
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn restrict_to_user(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn forget_session(session: &PtySession) {
    if let Some(token) = &session.session_token {
        super::release_token(token);
    }
    if let Some(path) = &session.codex_profile {
        let _ = std::fs::remove_file(path);
    }
}

/// PTY nativo. No Windows o pseudoconsole nasce com `CREATE_NO_WINDOW`
/// (`terminal::win_conpty`); no resto, o `portable-pty` do sistema.
pub(crate) fn open_pty(size: PtySize) -> Result<portable_pty::PtyPair, String> {
    #[cfg(windows)]
    {
        super::win_conpty::open(size)
    }
    #[cfg(not(windows))]
    {
        portable_pty::native_pty_system().openpty(size).map_err(|e| e.to_string())
    }
}

/// Crea un PTY, lanza el proceso dentro, y emite eventos `pty-data-{id}` al frontend.
///
/// `cols`/`rows` los manda el frontend ya medidos contra el tamaño real del contenedor
/// (`fitAddon.fit()`, ver Terminal.tsx) — antes se creaba fijo en 80x24 y recién se
/// resizeaba al tamaño real cuando disparaba el ResizeObserver, ya con el proceso vivo.
/// Muchas TUIs (agentes incluidos) leen el tamaño del terminal una sola vez al arrancar
/// y no vuelven a redibujar bien tras un `SIGWINCH` post-arranque — quedaban con
/// contenido cortado/desbordado hasta el primer redibujado manual. Con el tamaño correcto
/// desde el primer byte, ese problema no llega a existir.
#[tauri::command]
pub async fn pty_create(
    command: String,
    cwd: String,
    cols: u16,
    rows: u16,
    // `env`: variables extra a inyectar en el proceso — las declara la TUI custom que se
    // está lanzando (ver `agents::CustomAgent::env`). Se aplican DESPUÉS de las de la app,
    // así una TUI puede pisar `TERM`/`COLORTERM` si de verdad lo necesita.
    env: Option<std::collections::HashMap<String, String>>,
    // `prelaunch`: comandos a ejecutar antes del agente, ya resueltos y en orden (ver el
    // módulo `prelaunch`). Vacío = se lanza igual que siempre, sin ningún intermediario.
    prelaunch: Option<Vec<String>>,
    app: AppHandle,
) -> Result<u32, String> {
    let _update_guard = crate::agents::updates::activity_guard()?;
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let steps = prelaunch.unwrap_or_default();
    let pair = open_pty(size)?;

    let tab_id = env.as_ref().and_then(|e| e.get("ADE_TAB_ID")).cloned().filter(|tab| !tab.is_empty());
    // O token nasce aqui, não no ambiente que o frontend (ou um agente) mandou.
    // Só entra no registro depois que o processo existe. Um terminal restaurado
    // não passa por aqui: reanexa o PTY vivo e o processo conserva o token.
    let session_token = tab_id.as_ref().map(|_| uuid::Uuid::new_v4().to_string());
    let codex_profile_name = session_token.as_ref().map(|_| format!("ags-{}", uuid::Uuid::new_v4().simple()));
    let codex_profile = match (codex_profile_name.as_deref(), session_token.as_deref()) {
        (Some(name), Some(token)) if codex_stem(&command) => match write_codex_session_profile(name, token) {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("[ade-ags] não gravei o perfil do Codex; a sessão não vai na linha de comando: {error}");
                None
            }
        },
        _ => None,
    };
    let command = with_codex_identity(&command, tab_id.as_deref(), codex_profile.as_ref().and(codex_profile_name.as_deref()));
    let mut cmd = build_launch(&command, &steps)?;
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for var in crate::app::app_only_env().into_iter().chain(PARENT_SESSION_ENV.iter().copied()) {
        cmd.env_remove(var);
    }
    // El PATH del hijo es el del PTY (en Windows sale del registro, no del proceso de la app: la
    // app puede tener la carpeta de su ejecutable en el suyo y el hijo no).
    let child_path = cmd.get_env("PATH").map(|p| p.to_os_string()).unwrap_or_default();
    if let Some(path) = path_with_app_dir(&child_path) {
        cmd.env("PATH", path);
    }
    let env = env.unwrap_or_default();
    // Con una cuenta de la app, una API key heredada no le gana a su login.
    for var in crate::agents::overriding_env(env.keys()) {
        cmd.env_remove(var);
    }
    for (k, v) in env {
        // `ADE_SESSION` só o app emite. Um env de TUI custom não escolhe a sessão.
        if k == super::SESSION_ENV {
            continue;
        }
        cmd.env(k, v);
    }
    if let Some(tab) = &tab_id {
        cmd.env("ADE_TAB_ID", tab);
    }
    match &session_token {
        Some(token) => cmd.env(super::SESSION_ENV, token),
        None => cmd.env_remove(super::SESSION_ENV),
    };

    let id = {
        let mut counter = PTY_COUNTER.lock().unwrap_or_else(|e| e.into_inner());
        *counter += 1;
        *counter
    };

    // El grupo se crea ANTES del spawn para que ya exista cuando el proceso empiece a
    // tener descendencia propia.
    let mut group = ProcessGroup::new(id);
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            if let Some(path) = &codex_profile {
                let _ = std::fs::remove_file(path);
            }
            return Err(format!("Failed to spawn '{command}': {e}"));
        }
    };
    group.adopt(&*child);
    let root_pid = child.process_id();

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    // Una tab tiene UN terminal vivo. Si la ventana se recargó (o se restauró la sesión), el
    // frontend perdió los ids de los terminales de antes y lanza otros para las mismas tabs:
    // los viejos seguían corriendo, con la misma sesión del agente abierta ("conversation is
    // open in another app") y su memoria. Al llegar el nuevo, el anterior de esa tab se va.
    let replaced = {
        let mut reg = registry();
        let old: Vec<u32> = match &tab_id {
            Some(tab) => reg.iter().filter(|(_, s)| s.tab_id.as_deref() == Some(tab.as_str())).map(|(k, _)| *k).collect(),
            None => Vec::new(),
        };
        let removed: Vec<PtySession> = old.iter().filter_map(|k| reg.remove(k)).collect();
        for session in &removed {
            forget_session(session);
        }
        if let (Some(tab), Some(token), Some(pid)) = (tab_id.as_deref(), session_token.as_deref(), root_pid) {
            super::publish_token(tab, token, pid);
        }
        reg.insert(id, PtySession {
            master: pair.master,
            writer,
            killer: child,
            group,
            tab_id: tab_id.clone(),
            session_token: session_token.clone(),
            codex_profile,
        });
        (old, removed)
    };
    for (k, mut session) in replaced.0.iter().copied().zip(replaced.1) {
        session.group.kill_all();
        let _ = session.killer.kill();
        let _ = session.killer.wait();
        buffers().remove(&k);
    }
    buffers().insert(id, PtyBuffer::default());

    let app_clone = app.clone();
    let event_name = format!("pty-data-{id}");
    let exit_event = format!("pty-exit-{id}");

    // `spawn_blocking` y no `spawn`: `reader.read()` es una lectura bloqueante sobre el fd
    // del PTY, y dentro de un `tokio::spawn` normal secuestra un worker del runtime durante
    // toda la vida del proceso. Con unas pocas terminales abiertas se agotan los workers y
    // el resto de tareas async de la app deja de progresar.
    tokio::task::spawn_blocking(move || {
        // 64 KB y no 4: `read` devuelve lo que haya, así que con poca salida la latencia es
        // la misma, y con mucha (un build, un `npm install`) cada evento al webview lleva
        // hasta 16 veces más — cada uno es un JSON y un `eval` en el webview.
        let mut buf = vec![0u8; 64 * 1024];
        let mut text = Utf8Stream::default();
        let mut stream_end = 0u64;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    append_to_buffer(id, &buf[..n]);
                    stream_end += n as u64;
                    // Modo push del orquestador (Fase 9): si nadie observa esta tab, esto
                    // es una lectura atómica y vuelve.
                    crate::orchestrator::watch::observe(id, &buf[..n]);
                    let data = text.push(&buf[..n]);
                    if !data.is_empty() {
                        app_clone.emit(&event_name, PtyDataPayload { data, end: Some(stream_end) }).ok();
                    }
                }
                Err(_) => break,
            }
        }
        let rest = text.finish();
        if !rest.is_empty() {
            app_clone.emit(&event_name, PtyDataPayload { data: rest, end: Some(stream_end) }).ok();
        }
        // Se recoge el estado real del hijo antes de avisar al frontend. Sin este `wait`
        // el proceso queda además como zombie hasta que muere la app, porque nadie
        // reclama su status en el sistema.
        let code = registry()
            .remove(&id)
            .and_then(|mut session| {
                forget_session(&session);
                session.killer.wait().ok()
            })
            .map_or(0, |status| status.exit_code() as i32);
        crate::orchestrator::watch::note_exit(id, code);
        app_clone.emit(&exit_event, PtyExitPayload { code }).ok();
        buffers().remove(&id);
    });

    Ok(id)
}

/// El terminal vivo de una tab, si lo hay: el más nuevo con ese `ADE_TAB_ID`. Pura sobre las
/// sesiones `(id del PTY, tab)`.
pub(super) fn newest_for_tab<'a>(sessions: impl Iterator<Item = (u32, Option<&'a str>)>, tab_id: &str) -> Option<u32> {
    sessions.filter(|(_, tab)| *tab == Some(tab_id)).map(|(id, _)| id).max()
}

/// ¿Esta tab ya tiene un terminal corriendo? Se pregunta al montar un terminal: si la ventana se
/// recargó (el vigía de Vite lo hace con cada cambio que no puede aplicar en caliente) los
/// procesos siguen vivos en Rust, y lo correcto es reconectarse a ellos —con el agente en
/// medio de su trabajo— en vez de matarlos y lanzar otros con `--resume`.
#[tauri::command]
pub fn pty_for_tab(tab_id: String) -> Option<u32> {
    let reg = registry();
    newest_for_tab(reg.iter().map(|(id, s)| (*id, s.tab_id.as_deref())), &tab_id)
}

/// Se "conecta" a un PTY que ya existe (p. ej. al mover una tab a otra ventana sin
/// matar el proceso) y devuelve el scrollback acumulado para reproducirlo en el xterm nuevo.
#[tauri::command]
pub fn pty_attach(id: u32) -> Result<String, String> {
    if !registry().contains_key(&id) {
        return Err(format!("PTY session {id} not found"));
    }
    Ok(copy_scrollback_bytes(id)
        .map(|(data, _)| String::from_utf8_lossy(&data).into_owned())
        .unwrap_or_default())
}

/// Scrollback acumulado de un PTY vivo, sin exigir que el llamador sea el frontend.
/// Lo usa el servidor IPC (`tab output` de la CLI); a diferencia de `pty_attach`, esto
/// no implica "conectarse" a la sesión, solo mirarla.
///
/// Devuelve además el total de bytes que el proceso escribió desde que arrancó, que
/// **no** es el largo del buffer: el buffer se recorta al llegar al tope. El orquestador
/// usa ese total como cursor para pedir solo lo nuevo.
/// Solo el total de bytes escritos, sin copiar el scrollback.
///
/// Lo usa la espera de "¿la TUI ya arrancó?" del `--initprompt`, que consulta cada 100ms:
/// con `scrollback_of` cada consulta clonaría megabytes para mirar un contador.
/// `None` = ese PTY ya no existe.
pub fn output_total(id: u32) -> Option<u64> {
    buffers().get(&id).map(|b| b.total_bytes)
}

/// Bytes escritos desde que el PTY arrancó, sin copiar el scrollback. El guardado
/// periódico lo usa para no pedir 3 MB de una tab cuyo buffer no creció.
#[tauri::command]
pub fn pty_output_total(id: u32) -> Option<u64> {
    output_total(id)
}

/// Clona el buffer y suelta el mutex del PTY antes de decodificar UTF-8. Quien después
/// escribe en SQLite ya no tiene este lock, y este lock nunca se toma con el de SQLite.
fn copy_scrollback_bytes(id: u32) -> Option<(Vec<u8>, u64)> {
    let buffers = buffers();
    let buffer = buffers.get(&id)?;
    Some((buffer.data.clone(), buffer.total_bytes))
}

pub fn scrollback_of(id: u32) -> Option<(String, u64)> {
    copy_scrollback_bytes(id).map(|(data, total)| (String::from_utf8_lossy(&data).into_owned(), total))
}

/// Escribe al PTY desde código Rust (servidor IPC). `pty_write` es la versión `async`
/// que expone el mismo comportamiento al frontend vía invoke.
pub fn write_to_pty(id: u32, data: &str) -> Result<(), String> {
    let mut registry = registry();
    let session = registry.get_mut(&id).ok_or_else(|| format!("PTY session {id} not found"))?;
    session.writer.write_all(data.as_bytes()).map_err(|e| format!("PTY write error: {e}"))?;
    session.writer.flush().map_err(|e| format!("PTY flush error: {e}"))
}

/// Display an app notice as output. Never inject it as input into an agent's TUI.
pub fn display_notice(app:&tauri::AppHandle,tab_id:&str,message:&str) {
    let id={let reg=registry(); newest_for_tab(reg.iter().map(|(id,s)|(*id,s.tab_id.as_deref())),tab_id)};
    if let Some(id)=id {
        let _=app.emit(&format!("pty-data-{id}"),PtyDataPayload {data:format!("\r\n{message}\r\n"),end:None});
    }
}

/// Escribe datos (input del usuario desde xterm.js) al PTY.
#[tauri::command]
pub async fn pty_write(id: u32, data: String) -> Result<(), String> {
    write_to_pty(id, &data)
}

// A hidden/unlaid-out slot can briefly measure zero during a mode change. Keep the
// last usable PTY size instead of forwarding that transient measurement to the OS.
// Bound pathological measurements too: ConPTY uses signed dimensions and TUIs may
// allocate a screen buffer proportional to rows * cols.
pub(super) const MAX_PTY_DIMENSION: u16 = 1000;

pub(super) fn measured_pty_size(cols: u16, rows: u16) -> Option<PtySize> {
    if cols == 0 || rows == 0 {
        return None;
    }
    Some(PtySize {
        cols: cols.min(MAX_PTY_DIMENSION),
        rows: rows.min(MAX_PTY_DIMENSION),
        pixel_width: 0,
        pixel_height: 0,
    })
}

pub(super) fn resize_measured_pty(master: &dyn MasterPty, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(size) = measured_pty_size(cols, rows) {
        master.resize(size).map_err(|e| format!("Resize error: {e}"))?;
    }
    Ok(())
}

/// Redimensiona el PTY cuando cambia el tamaño de xterm.js.
#[tauri::command]
pub async fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let registry = registry();
    if let Some(session) = registry.get(&id) {
        resize_measured_pty(session.master.as_ref(), cols, rows)
    } else {
        Err(format!("PTY session {id} not found"))
    }
}

/// Termina el proceso del PTY y limpia la sesión.
#[tauri::command]
pub async fn pty_kill(id: u32) -> Result<(), String> {
    if let Some(mut session) = registry().remove(&id) {
        forget_session(&session);
        // El grupo va PRIMERO: el respaldo por `ppid` de unix necesita al padre todavía
        // vivo para poder recorrer el árbol (una vez muerto, el kernel reasigna a los
        // hijos y se pierde el vínculo). Con cgroups o Job Objects el orden da igual.
        session.group.kill_all();
        session.killer.kill().map_err(|e| format!("Kill error: {e}"))?;
        // Se reclama el status para que el hijo no quede zombie: `kill` solo manda la
        // señal, no espera a que el proceso muera de verdad.
        let _ = session.killer.wait();
    }
    buffers().remove(&id);
    Ok(())
}

/// Mata todas las sesiones vivas y su descendencia. Se llama al salir de la app.
///
/// Hace falta explícitamente porque el registry es un `lazy_static`: Rust no corre
/// destructores de estáticos al terminar el proceso, así que sin esto el `Drop` de
/// `ProcessGroup` nunca se ejecutaría por esta vía.
///
/// En Windows hay además una segunda red que NO depende de que esto llegue a correr: el
/// job tiene `KILL_ON_JOB_CLOSE`, así que un cierre forzado desde el Administrador de
/// tareas igual se lleva todo cuando el kernel cierra los handles del proceso muerto.
pub fn kill_all_sessions() {
    let sessions: Vec<PtySession> = registry().drain().map(|(_, s)| s).collect();
    for mut session in sessions {
        forget_session(&session);
        session.group.kill_all();
        let _ = session.killer.kill();
        let _ = session.killer.wait();
    }
    buffers().clear();
}

#[cfg(test)]
mod source_tests {
    #[test]
    fn perfil_do_codex_nao_chama_processo_externo_de_acl() {
        let needle = ["ica", "cls"].concat();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut pending = vec![root];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap().to_ascii_lowercase();
                assert!(!text.contains(&needle), "{} ainda menciona o processo de ACL", path.display());
            }
        }
    }
}
