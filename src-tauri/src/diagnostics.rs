//! Diagnóstico (Configurações → Diagnóstico), só leitura: a versão, a pasta de dados, o tamanho do banco e os
//! terminais vivos. Não envia sinal a nenhum processo. Quem encerra um terminal é a aba dele.

use std::path::Path;

use serde::Serialize;

use crate::terminal::{pty_sessions_snapshot, PtySessionInfo};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub version: String,
    /// A pasta de dados desta instância (`ADE_AGS_DATA_DIR` ou `~/.ags`). `None` se o sistema não tem home.
    pub data_dir: Option<String>,
    /// Instância isolada (`ADE_AGS_DATA_DIR` definido): o app de uso normal fica em outra pasta.
    pub isolated: bool,
    /// Tamanho do arquivo do banco (sem o WAL). Zero se ainda não existe.
    pub database_bytes: u64,
    pub terminals: Vec<PtySessionInfo>,
}

/// Os bytes de um arquivo comum. Ausente, ilegível ou um link: zero (o diagnóstico não quebra por isso).
pub(crate) fn file_bytes(path: &Path) -> u64 {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => 0,
    }
}

/// Monta a tela de Diagnóstico a partir do que o app sabe agora. Não toca em nada.
pub(crate) fn snapshot(version: &str, data_dir: Option<&Path>, isolated: bool, terminals: Vec<PtySessionInfo>) -> DiagnosticsSnapshot {
    DiagnosticsSnapshot {
        version: version.to_owned(),
        data_dir: data_dir.map(|d| d.to_string_lossy().into_owned()),
        isolated,
        database_bytes: data_dir.map(|d| file_bytes(&d.join("data.db"))).unwrap_or(0),
        terminals,
    }
}

#[tauri::command]
pub fn diagnostics_snapshot() -> Result<DiagnosticsSnapshot, String> {
    let data_dir = crate::util::datadir::ags_home();
    Ok(snapshot(
        env!("CARGO_PKG_VERSION"),
        data_dir.as_deref(),
        crate::util::datadir::is_isolated(),
        pty_sessions_snapshot(),
    ))
}

#[cfg(test)]
mod test;
