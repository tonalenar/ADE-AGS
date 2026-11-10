//! Varias cuentas de una misma TUI, conviviendo.
//!
//! ## Cómo funciona
//!
//! Las CLIs de agentes guardan su login en un directorio propio (`~/.claude`, `~/.codex`,
//! …). Casi todas dejan mover ese directorio con una variable de entorno, y al hacerlo se
//! llevan TODO con él: credenciales, configuración e historial. O sea que "una cuenta" es,
//! literalmente, un directorio: se apunta la variable a otro lado y la TUI arranca como si
//! fuera una instalación nueva, sin tocar la del sistema.
//!
//! Cada conta vive em `<dados da app>/accounts/<agente>/<nome>`. O frontend envia somente o
//! id da conta ao `pty_create`; o backend resolve o perfil e qualquer credencial no keyring
//! imediatamente antes de criar o processo, sem devolver o ambiente ao WebView.
//!
//! ## Por qué no symlinks
//!
//! Tentaba enlazar el directorio "activo" y cambiar el enlace al elegir cuenta. No sirve:
//! las TUIs reescriben sus archivos de credenciales en el lugar, así que dos procesos
//! vivos con cuentas distintas se pisarían a través del mismo enlace, y cambiar de cuenta
//! con una sesión abierta le movería el piso. Una variable por proceso no tiene ese
//! problema: cada tab queda apuntada a su directorio para siempre.
//!
//! ## Qué NO hace este módulo
//!
//! O login do perfil fica no diretório da TUI. Credenciais de API key ficam no keyring do
//! SO e só são carregadas pelo backend para o processo escolhido; não voltam pelo IPC. O
//! módulo também lê o marcador de login e, para Claude, o email em `.claude.json` para
//! mostrar uma identidade reconhecível.


mod commands;
pub(crate) mod antigravity_oauth;
pub(crate) mod antigravity_access;
mod health;
pub mod pools;
mod profiles;
mod secrets;
mod store;
#[cfg(test)]
mod test;

pub use commands::*;
pub use health::*;
pub use store::*;
