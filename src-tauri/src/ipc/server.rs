//! Servidor IPC: escucha en loopback y despacha cada request a `commands`.
//!
//! Ver `protocol.rs` para el formato del mensaje y el modelo de autorización.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

use super::commands;
use super::protocol::{
    handshake_path, instance_handshake_path, Handshake, Request, Response, HANDSHAKE_ENV, PROTOCOL_VERSION,
};

/// Cada cuánto se revisa que los handshakes sigan apuntando a esta instancia.
const WATCH_EVERY: Duration = Duration::from_secs(3);

/// Conexiones atendidas a la vez. Holgado: cada agente con un `run_await` o un permiso
/// pendiente ocupa una mientras espera, y una flota grande tiene decenas.
pub(super) const MAX_CONNECTIONS: usize = 256;

/// El tamaño máximo de una request. La más grande legítima es un handoff o una memoria,
/// que ya tienen sus propios topes muy por debajo de esto.
pub(super) const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

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
        eprintln!("[ade-ags] no se pudo iniciar el servidor IPC: {e}");
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
    let open = std::sync::Arc::new(AtomicUsize::new(0));
    let socket = match super::transport::start_credential_server(app.clone(), token.clone(), endpoint.clone(), open.clone()) {
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
    write_handshake(&handshake_path(), &handshake)?;
    std::thread::spawn(move || watch_handshakes(&handshake));

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            // Cualquier proceso local puede conectarse, con token o sin él: sin tope, abrir
            // conexiones sin mandar nada crea un thread por cada una.
            if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                open.fetch_sub(1, Ordering::SeqCst);
                drop(stream);
                continue;
            }
            let app = app.clone();
            let token = token.clone();
            let open = open.clone();
            // Un cliente lento (o que abre la conexión y no manda nada) no debe bloquear
            // a los demás, así que cada conexión se atiende en su propio thread.
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
                let Ok(writer) = stream.try_clone() else {
                    open.fetch_sub(1, Ordering::SeqCst);
                    return;
                };
                // TCP não entrega PID. Memória e swarm fecham sem ele.
                handle_connection(stream, writer, &app, &token, None);
                open.fetch_sub(1, Ordering::SeqCst);
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
fn write_handshake(path: &Path, handshake: &Handshake) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(handshake).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", handshake.pid));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
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
        if global_needs_rewrite(read_handshake(&global).as_ref(), own.pid, is_alive) {
            let _ = write_handshake(&global, own);
        }
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
) {
    let mut reader = BufReader::new(reader);

    let mut line = String::new();
    // Con tope: sin él, una "línea" que nunca termina se acumula en memoria entera.
    if (&mut reader).take(MAX_REQUEST_BYTES).read_line(&mut line).is_err() || line.trim().is_empty() {
        return;
    }
    if !line.ends_with('\n') && line.len() as u64 >= MAX_REQUEST_BYTES {
        let response = Response::err(format!("Request demasiado grande (máximo {MAX_REQUEST_BYTES} bytes)"));
        if let Ok(json) = serde_json::to_string(&response) {
            let _ = writeln!(writer, "{json}");
        }
        return;
    }

    let mut command = String::new();
    let response = match serde_json::from_str::<Request>(&line) {
        Err(e) => Response::err(format!("Request inválida: {e}")),
        Ok(req) if !token_matches(&req.token, expected_token) => {
            Response::err("Token inválido — volvé a leer ~/.ags/ipc.json")
        }
        Ok(req) => {
            command = req.command.clone();
            super::transport::with_client_pid(client_pid, || commands::dispatch(app, &req.command, &req.args))
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
