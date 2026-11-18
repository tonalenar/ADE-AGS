//! Dónde se guarda el token de cada cuenta: en el llavero del sistema.
//!
//! - macOS: el Llavero (Keychain).
//! - Windows: el Administrador de credenciales.
//! - Linux: el Secret Service (GNOME Keyring, KWallet), por D-Bus.
//!
//! Es lo mismo que hace VS Code, y por lo mismo: el token queda cifrado con la sesión del
//! usuario y no en un archivo que cualquier proceso pueda copiar.
//!
//! ## Cuando no hay llavero
//!
//! No se guarda un token nuevo en disco. Los archivos `git-secrets` que dejó una versión
//! anterior se migran al llavero al leerlos; si el llavero no está disponible, se conserva
//! el archivo y la operación falla con un mensaje claro.
//!
//! Todo esto bloquea (D-Bus, Keychain), así que solo se llama desde hilos de bloqueo.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.luis.controlcode.git";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Secret {
    pub access_token: String,
    /// Solo los tokens OAuth que vencen (GitLab: 2 h) traen con qué renovarse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix, segundos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Storage {
    Keyring,
    File,
}

lazy_static::lazy_static! {
    /// Leer el llavero cuesta (y en macOS puede preguntar): una vez leído, queda acá.
    static ref CACHE: Mutex<HashMap<String, Secret>> = Mutex::new(HashMap::new());
}

fn file_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("git-secrets").join(format!("{id}.json"))
}

fn entry(id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, id)
}

struct WipeString(String);

impl Drop for WipeString {
    fn drop(&mut self) {
        // SAFETY: bytes zero formam UTF-8 válido e removem a cópia serializada do token.
        unsafe {
            self.0.as_mut_vec().fill(0);
        }
        self.0.clear();
    }
}

fn save_with_keyring(
    data_dir: &Path,
    id: &str,
    secret: &Secret,
    store: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Storage, String> {
    let json = WipeString(serde_json::to_string(secret).map_err(|e| e.to_string())?);
    store(&json.0)
        .map_err(|e| format!("Não foi possível guardar o token no cofre do sistema: {e}"))?;
    let legacy = file_path(data_dir, id);
    if legacy.exists() {
        std::fs::remove_file(&legacy).map_err(|e| {
            format!(
                "O token foi guardado no cofre, mas o arquivo legado não pôde ser removido: {e}"
            )
        })?;
    }
    CACHE.lock().unwrap().insert(id.to_string(), secret.clone());
    Ok(Storage::Keyring)
}

fn migrate_legacy_with(
    data_dir: &Path,
    id: &str,
    store: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Secret, String> {
    let legacy = file_path(data_dir, id);
    let json = WipeString(std::fs::read_to_string(&legacy).map_err(|_| {
        "Não foi possível ler o token legado; o arquivo foi preservado.".to_string()
    })?);
    let secret: Secret = serde_json::from_str(&json.0)
        .map_err(|_| "O token legado está inválido; o arquivo foi preservado.".to_string())?;
    save_with_keyring(data_dir, id, &secret, store)?;
    Ok(secret)
}

pub fn save(data_dir: &Path, id: &str, secret: &Secret) -> Result<Storage, String> {
    save_with_keyring(data_dir, id, secret, |json| {
        entry(id)
            .and_then(|e| e.set_password(json))
            .map_err(|e| e.to_string())
    })
}

pub fn load(data_dir: &Path, id: &str) -> Result<Secret, String> {
    if let Some(s) = CACHE.lock().unwrap().get(id) {
        return Ok(s.clone());
    }
    // Arquivos legados podem conter um token mais novo que uma entrada antiga do keyring.
    // Migra antes da leitura normal e só remove a cópia em disco depois de gravar no cofre.
    let legacy = file_path(data_dir, id);
    if legacy.exists() {
        return migrate_legacy_with(data_dir, id, |json| {
            entry(id)
                .and_then(|e| e.set_password(json))
                .map_err(|e| e.to_string())
        });
    }
    let json = WipeString(match entry(id).and_then(|e| e.get_password()) {
        Ok(json) => json,
        Err(keyring_err) => {
            return Err(format!(
                "Não foi possível acessar o token no cofre do sistema ({keyring_err}). Entre novamente."
            ));
        }
    });
    let secret: Secret = serde_json::from_str(&json.0).map_err(|e| e.to_string())?;
    CACHE.lock().unwrap().insert(id.to_string(), secret.clone());
    Ok(secret)
}

/// Dónde está guardado, sin leerlo. Para mostrarlo en la cuenta.
pub fn storage_of(data_dir: &Path, id: &str) -> Storage {
    if file_path(data_dir, id).exists() {
        Storage::File
    } else {
        Storage::Keyring
    }
}

pub fn delete(data_dir: &Path, id: &str) {
    CACHE.lock().unwrap().remove(id);
    if let Ok(e) = entry(id) {
        let _ = e.delete_credential();
    }
    let _ = std::fs::remove_file(file_path(data_dir, id));
}

#[cfg(test)]
pub fn clear_cache_for_tests() {
    CACHE.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("forge-secret-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn token_legado_mais_novo_substitui_keyring_antigo_e_e_migrado() {
        let dir = TempDir::new();
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let old = Secret {
            access_token: "token-antigo-falso".into(),
            refresh_token: None,
            expires_at: None,
        };
        let new = Secret {
            access_token: "token-novo-falso".into(),
            refresh_token: Some("refresh-novo".into()),
            expires_at: Some(99),
        };
        let mut keyring = HashMap::from([(id.clone(), serde_json::to_string(&old).unwrap())]);
        let legacy = file_path(&dir.0, &id);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, serde_json::to_string(&new).unwrap()).unwrap();

        let loaded = migrate_legacy_with(&dir.0, &id, |json| {
            keyring.insert(id.clone(), json.to_string());
            Ok(())
        })
        .unwrap();

        assert_eq!(loaded, new);
        assert!(!file_path(&dir.0, &id).exists());
        let new_json = serde_json::to_string(&new).unwrap();
        assert_eq!(
            keyring.get(&id).map(String::as_str),
            Some(new_json.as_str())
        );
        CACHE.lock().unwrap().remove(&id);
    }

    #[test]
    fn falha_do_keyring_nao_grava_token_novo_em_arquivo() {
        let dir = TempDir::new();
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let secret = Secret {
            access_token: "token-falso".into(),
            refresh_token: None,
            expires_at: None,
        };
        let result =
            save_with_keyring(&dir.0, &id, &secret, |_| Err("keyring indisponível".into()));
        assert!(result.is_err());
        assert!(!file_path(&dir.0, &id).exists());
    }
}
