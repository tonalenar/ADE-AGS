//! Servidor IPC: escucha en loopback y despacha cada request a `commands`.
//!
//! Ver `protocol.rs` para el formato del mensaje y el modelo de autorización.

use std::io::{BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

use super::commands;
use super::intake::{self, Intake, Slot, Slots};
use super::protocol::{
    handshake_path, instance_handshake_path, Handshake, Request, Response, HANDSHAKE_ENV, PROTOCOL_VERSION,
};

/// Cada cuánto se revisa que los handshakes sigan apuntando a esta instancia.
const WATCH_EVERY: Duration = Duration::from_secs(3);

/// Compara el token sin cortar en el primer byte distinto, para que el tiempo de respuesta
/// no diga cuántos caracteres se acertaron.
pub(super) fn token_matches(given: &str, expected: &str) -> bool {
    let (given, expected) = (given.as_bytes(), expected.as_bytes());
    if given.len() != expected.len() {
        return false;
    }
    given.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Exporta [`HANDSHAKE_ENV`] con el handshake propio de esta instancia, para que lo hereden
/// todos sus procesos hijos.
///
/// Toca el entorno del proceso, así que tiene que correr con un solo hilo: en `app::run`,
/// junto a `path_env::configure` (ver ahí por qué).
pub fn export_instance_env() {
    let path = instance_handshake_path(std::process::id());
    // SAFETY: `app::run` lo llama antes de crear cualquier hilo (ver arriba).
    unsafe { std::env::set_var(HANDSHAKE_ENV, path) };
}

/// Levanta el servidor en un thread propio y publica el archivo de handshake.
///
/// Un fallo acá no debe impedir que la app arranque: sin servidor IPC se pierde la CLI,
/// pero la app en sí sigue siendo perfectamente usable.
pub fn start(app: AppHandle) {
    if let Err(e) = try_start(app) {
        eprintln!("[ade-ags] não foi possível iniciar o servidor IPC: {e}");
    }
}

fn try_start(app: AppHandle) -> Result<(), String> {
    // Puerto 0 = el SO elige uno libre. Atarse a un puerto fijo haría que dos instancias
    // (o cualquier otro programa que ya lo tuviera) se pisaran.
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = Uuid::new_v4().to_string();

    let pid = std::process::id();
    let endpoint = super::protocol::credential_endpoint(pid);
    // Cada canal com as suas vagas (F-03): quem enche o TCP não tira vaga do canal de credencial.
    let tcp_slots = Slots::new();
    let socket = match super::transport::start_credential_server(app.clone(), token.clone(), endpoint.clone(), Slots::new()) {
        Ok(()) => Some(endpoint),
        Err(error) => {
            eprintln!("[ade-ags] socket de credencial indisponível: {error}");
            None
        }
    };
    let handshake = Handshake {
        port,
        token: token.clone(),
        pid,
        protocol: PROTOCOL_VERSION,
        socket,
    };
    sweep_dead_instances();
    write_handshake(&instance_handshake_path(handshake.pid), &handshake)?;
    publish_global(&handshake_path(), &handshake)?;
    std::thread::spawn(move || watch_handshakes(&handshake));

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            // Cualquier proceso local puede conectarse, con token o sin él: sin tope, abrir
            // conexiones sin mandar nada crea un thread por cada una. Também há teto para as que ainda não
            // provaram o token (`intake::MAX_UNAUTHENTICATED`).
            let Some(slot) = tcp_slots.try_acquire() else {
                drop(stream);
                continue;
            };
            let app = app.clone();
            let token = token.clone();
            // Un cliente lento (o que abre la conexión y no manda nada) no debe bloquear
            // a los demás, así que cada conexión se atiende en su propio thread.
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(intake::READ_TIMEOUT_SECS)));
                let Ok(writer) = stream.try_clone() else { return };
                // TCP não entrega PID. Memória e swarm fecham sem ele.
                handle_connection(stream, writer, &app, &token, None, slot);
            });
        }
    });

    Ok(())
}

/// Escribe el handshake con permisos restringidos al usuario: el token que contiene ES
/// la credencial, y en un `$HOME` compartido cualquier otra cuenta podría leerlo.
///
/// Se escribe aparte y se renombra: la CLI lo lee en cada llamada, y con una escritura en
/// el lugar podía leerlo a medio escribir y tomarlo por corrupto.
pub(super) fn write_handshake(path: &Path, handshake: &Handshake) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let json = serde_json::to_string_pretty(handshake).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", handshake.pid));
    // F-05: o temporário nasce já 0600 e exclusivo (`create_new` = O_EXCL, que também não segue um link plantado no
    // nome previsível). Um sobrado de uma queda é apagado antes: `remove_file` tira o link, não o alvo dele.
    let _ = std::fs::remove_file(&tmp);
    let written = create_private_file(&tmp).and_then(|mut file| {
        file.write_all(json.as_bytes())?;
        file.flush()
    });
    if let Err(error) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Cria o arquivo novo, só do dono desde o primeiro instante (sem janela entre escrever e dar `chmod`).
fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// As pastas que o handshake cria nascem `0700`. Uma `ipc/` que já existia (versão antiga, `0755`) é fechada também:
/// ela é nossa e só guarda handshakes e sockets. A pasta de dados que já existia não é mexida.
fn create_private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| e.to_string())?;
        if dir.file_name().is_some_and(|name| name == "ipc") {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())
    }
}

/// Publicação inicial e manutenção compartilham a política de posse do global.
pub(super) fn publish_global(path: &Path, own: &Handshake) -> Result<(), String> {
    if global_needs_rewrite(read_handshake(path).as_ref(), own.pid, is_alive) {
        write_handshake(path, own)?;
    }
    Ok(())
}

fn read_handshake(path: &Path) -> Option<Handshake> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Si hay alguien escuchando en ese puerto. Un handshake que apunta a un puerto muerto es
/// de una instancia que ya no existe (se cerró de golpe, o la mató el sistema).
fn is_alive(handshake: &Handshake) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, handshake.port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Qué hacer con el handshake global según lo que haya en el archivo.
///
/// Solo se reescribe cuando falta, no se entiende o es de una instancia muerta. Si es de
/// otra instancia viva se respeta: pelearse por el archivo lo reescribiría cada pocos
/// segundos, y los agentes de cada una ya van a la suya por [`HANDSHAKE_ENV`].
pub(super) fn global_needs_rewrite(current: Option<&Handshake>, own_pid: u32, alive: impl Fn(&Handshake) -> bool) -> bool {
    match current {
        None => true,
        Some(h) if h.pid == own_pid => false,
        Some(h) => !alive(h),
    }
}

/// Vuelve a publicar los handshakes si alguien los borró o si el global quedó apuntando a
/// una instancia muerta: la app sigue corriendo y sus agentes tienen que poder alcanzarla.
fn watch_handshakes(own: &Handshake) {
    let instance = instance_handshake_path(own.pid);
    let global = handshake_path();
    loop {
        std::thread::sleep(WATCH_EVERY);
        if read_handshake(&instance).is_none_or(|h| h.token != own.token) {
            let _ = write_handshake(&instance, own);
        }
        let _ = publish_global(&global, own);
    }
}

/// Si hay OTRA instancia de la app viva (la app abierta dos veces, un `tauri dev` al lado de
/// la instalada, una `--headless` de CI). Se mira antes de levantar el servidor propio, así
/// que el handshake de esta todavía no existe y no se cuenta a sí misma.
///
/// Importa al arrancar: las limpiezas de inicio (`runs::sweep_orphans` y compañía) dan por
/// muertas las tareas "corriendo", y con otra instancia viva esas tareas son SUYAS y siguen
/// corriendo.
pub fn other_instance_alive() -> bool {
    let own = std::process::id();
    let dir = instance_handshake_path(0).parent().map(Path::to_path_buf);
    let Some(entries) = dir.and_then(|d| std::fs::read_dir(d).ok()) else { return false };
    entries
        .flatten()
        .filter_map(|entry| read_handshake(&entry.path()))
        .any(|h| h.pid != own && is_alive(&h))
}

/// Borra los handshakes propios de instancias que ya no existen: una que se cerró de golpe
/// no llegó a hacerlo.
fn sweep_dead_instances() {
    let dir = instance_handshake_path(0).parent().map(Path::to_path_buf);
    let Some(entries) = dir.and_then(|d| std::fs::read_dir(d).ok()) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let dead = match read_handshake(&path) {
            Some(h) => !is_alive(&h),
            // Un temporal a medio escribir de otra instancia no se toca.
            None => path.extension().is_some_and(|e| e == "json"),
        };
        if dead {
            if let Some(socket) = read_handshake(&path).and_then(|h| h.socket) {
                let _ = std::fs::remove_file(socket);
            }
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Borra los handshakes de esta instancia al salir, para no dejar apuntando a un puerto que
/// ya no escucha nadie. El global, solo si es suyo: si otra instancia lo escribió después,
/// borrarlo dejaba a los agentes de ESA sin forma de alcanzarla.
pub fn cleanup() {
    let pid = std::process::id();
    super::transport::remove_credential_endpoint(pid);
    let _ = std::fs::remove_file(instance_handshake_path(pid));
    let global = handshake_path();
    if read_handshake(&global).is_some_and(|h| h.pid == pid) {
        let _ = std::fs::remove_file(global);
    }
}

pub(super) fn handle_connection(
    reader: impl Read,
    mut writer: impl Write,
    app: &AppHandle,
    expected_token: &str,
    client_pid: Option<u32>,
    slot: Slot,
) {
    let mut slot = slot;
    let mut reader = BufReader::new(reader);

    // F-03: a leitura é limitada antes do token (janela pequena, prazo total) e só depois lê o resto do pedido.
    let started = std::time::Instant::now();
    let mut now_ms = || started.elapsed().as_millis() as u64;
    let line = match intake::read_request(&mut reader, expected_token, &mut now_ms, &mut || slot.authenticated()) {
        Intake::Line(line) => line,
        Intake::Closed => return,
        Intake::Refused(message) => {
            if let Ok(json) = serde_json::to_string(&Response::err(message)) {
                let _ = writeln!(writer, "{json}");
            }
            return;
        }
    };

    let mut command = String::new();
    let response = match serde_json::from_str::<Request>(&line) {
        Err(e) => Response::err(format!("Requisição inválida: {e}")),
        Ok(req) if !token_matches(&req.token, expected_token) => {
            Response::err("Token inválido — leia de novo ~/.ags/ipc.json")
        }
        Ok(req) => {
            command = req.command.clone();
            // Um pânico no comando não pode fechar a conexão calada: a CLI só veria "sem resposta".
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                super::transport::with_client_pid(client_pid, || commands::dispatch(app, &req.command, &req.args))
            }))
            .unwrap_or_else(|_| Response::err(format!("Erro interno do app ao executar `{}`: o comando falhou no meio. Tente de novo; se repetir, veja o log do app.", req.command)))
        }
    };

    if let Ok(json) = serde_json::to_string(&response) {
        // Fase 9: se contabiliza lo que la CLI se lleva de verdad — el JSON ya serializado,
        // no una estimación de antes de armarlo. Es el número que ve el usuario en el
        // indicador de la UI. Las requests rechazadas (token inválido) no cuentan: no
        // salieron de ningún orquestador nuestro.
        if !command.is_empty() {
            crate::orchestrator::record_response(app, &command, &json);
        }
        let _ = writeln!(writer, "{json}");
        let _ = writer.flush();
    }
}
