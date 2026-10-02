//! Chat: el usuario conversa con un agente desde la pantalla, y el agente contesta con
//! `ccode say`.
//!
//! Un terminal de agente mezcla todo en un solo flujo: lo que el usuario escribió, lo que
//! el agente piensa, las llamadas a herramientas. Para una pregunta simple, o para dejar un
//! encargo y volver más tarde, hace falta un canal aparte donde cada mensaje sea un globo.
//!
//! ## Hilos
//!
//! Cada agente tiene siete hilos, uno por color. Sirven para llevar varias conversaciones
//! con el mismo agente sin mezclarlas ("azul" el bug de login, "verde" el diseño). El
//! mensaje del usuario le llega con su hilo, y el agente contesta en el hilo del último
//! mensaje que recibió (`current_thread`), salvo que diga otro con `--thread`.
//!
//! ## Qué se guarda
//!
//! Todos los mensajes, por agente (id de tab), con un tope: pasado el límite se van los más
//! viejos. Es un archivo y no la base: se reescribe entero, sin consultas por campo.
//!
//! El texto es texto: la pantalla lo muestra tal cual, sin interpretarlo. Lo que escribe un
//! agente no puede traer HTML ni secuencias de control.
//!
//! Este módulo es el modelo (puro) y el archivo; el envío y los comandos están en
//! `ipc::commands::chat`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Los hilos, en el orden en que se muestran.
pub const THREADS: [&str; 7] = ["blue", "purple", "pink", "red", "orange", "yellow", "green"];
pub const DEFAULT_THREAD: &str = "blue";

/// Cuántos mensajes se guardan por agente.
pub const MAX_MESSAGES: usize = 1000;
/// Cuánto cabe en un mensaje. Un informe largo va en una nota.
pub const MAX_TEXT: usize = 8000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Lo que escribió el usuario.
    User,
    /// La respuesta del agente (`ccode say`).
    Say,
    /// Un aviso intermedio del agente (`ccode say --progress`): su turno sigue.
    Progress,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread: String,
    pub kind: Kind,
    pub text: String,
    /// Segundos unix.
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// El hilo del último mensaje del usuario: donde contesta el agente por defecto.
    #[serde(default)]
    pub current_thread: String,
    #[serde(default)]
    pub messages: Vec<Message>,
}

// ── Lógica pura ─────────────────────────────────────────────────────

/// Un hilo válido: acepta el nombre en inglés (`blue`) o el que ve el usuario en portugués
/// (`azul`), sin mayúsculas.
pub fn parse_thread(raw: &str) -> Result<&'static str, String> {
    let wanted = raw.trim().to_lowercase();
    let id = match wanted.as_str() {
        "blue" | "azul" => "blue",
        "purple" | "roxo" => "purple",
        "pink" | "rosa" => "pink",
        "red" | "vermelho" => "red",
        "orange" | "laranja" => "orange",
        "yellow" | "amarelo" => "yellow",
        "green" | "verde" => "green",
        _ => return Err(format!("A thread '{raw}' não existe. Threads: {}.", THREADS.join(", "))),
    };
    Ok(THREADS.iter().find(|t| **t == id).copied().unwrap_or(DEFAULT_THREAD))
}

/// El texto de un mensaje: sin caracteres de control (salvo saltos de línea y tabulaciones),
/// sin espacios sobrantes en los extremos y dentro del límite.
pub fn clean_text(raw: &str) -> Result<String, String> {
    let text: String = raw
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("A mensagem está vazia.".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("A mensagem passa de {MAX_TEXT} caracteres: ponha o detalhe numa nota e diga onde está."));
    }
    Ok(text)
}

/// Suma un mensaje, y si el usuario fue quien habló, deja ese hilo como el actual.
pub fn push(conversation: &mut Conversation, thread: &str, kind: Kind, text: String, at: i64) -> Message {
    let message = Message { id: uuid::Uuid::new_v4().simple().to_string()[..10].to_string(), thread: thread.into(), kind, text, at };
    if kind == Kind::User {
        conversation.current_thread = thread.into();
    }
    conversation.messages.push(message.clone());
    let extra = conversation.messages.len().saturating_sub(MAX_MESSAGES);
    if extra > 0 {
        conversation.messages.drain(..extra);
    }
    message
}

/// Dónde contesta el agente: el hilo que pidió, o el del último mensaje del usuario, o el
/// primero si todavía nadie habló.
pub fn reply_thread(conversation: &Conversation, asked: Option<&str>) -> Result<&'static str, String> {
    if let Some(a) = asked.filter(|a| !a.trim().is_empty()) {
        return parse_thread(a);
    }
    if conversation.current_thread.is_empty() {
        return Ok(DEFAULT_THREAD);
    }
    parse_thread(&conversation.current_thread)
}

/// Lo que se recuerda de un hilo: los últimos `turns` turnos (un mensaje del usuario y lo
/// que el agente contestó), o todo con `turns = None`.
pub fn recall<'a>(conversation: &'a Conversation, thread: &str, turns: Option<usize>) -> Vec<&'a Message> {
    let in_thread: Vec<&Message> = conversation.messages.iter().filter(|m| m.thread == thread).collect();
    let Some(turns) = turns else { return in_thread };
    let user_starts: Vec<usize> =
        in_thread.iter().enumerate().filter(|(_, m)| m.kind == Kind::User).map(|(i, _)| i).collect();
    // Antes del primer mensaje del usuario puede haber avisos sueltos del agente: son parte
    // del hilo y, si piden pocos turnos, simplemente quedan fuera.
    match user_starts.len().checked_sub(turns) {
        Some(skip) => in_thread[user_starts[skip]..].to_vec(),
        None => in_thread,
    }
}

/// El mensaje tal como lo lee el agente: de quién viene, en qué hilo, y cómo contestar. Es
/// lo único que le dice que existe un chat, y que el texto de la terminal no llega al
/// usuario.
pub fn framed(thread: &str, text: &str) -> String {
    format!(
        "[Chat do usuário · thread: {thread}] {text}\n(Responda SOMENTE com `ccode say \"...\"`: o texto do terminal não chega ao usuário no chat. Para uma tarefa longa, avise o andamento com `ccode say --progress \"...\"`.)"
    )
}

// ── Archivo ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct ChatFile {
    #[serde(default)]
    conversations: BTreeMap<String, Conversation>,
}

lazy_static::lazy_static! {
    static ref LOCK: Mutex<()> = Mutex::new(());
}

fn file_path() -> Result<PathBuf, String> {
    let dir = dirs::home_dir().ok_or("Não foi possível achar a pasta do usuário")?.join(".controlcode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("chat.json"))
}

fn read_file() -> ChatFile {
    let Ok(path) = file_path() else { return ChatFile::default() };
    std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn write_file(file: &ChatFile) -> Result<(), String> {
    let path = file_path()?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string(file).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// La conversación de un agente (vacía si todavía no hay).
pub fn conversation(tab_id: &str) -> Conversation {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_file().conversations.remove(tab_id).unwrap_or_default()
}

/// Lee la conversación, aplica `change` y la guarda, bajo el mismo cerrojo.
pub fn update<T>(tab_id: &str, change: impl FnOnce(&mut Conversation) -> Result<T, String>) -> Result<T, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = read_file();
    let conv = file.conversations.entry(tab_id.to_string()).or_default();
    let out = change(conv)?;
    write_file(&file)?;
    Ok(out)
}

#[cfg(test)]
mod test;
