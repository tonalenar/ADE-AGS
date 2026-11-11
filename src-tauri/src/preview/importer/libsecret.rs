//! Leitura da senha do Chromium no Secret Service do Linux (libsecret: GNOME Keyring, KWallet via bridge…).
//!
//! O Chromium guarda a senha do `v11` num item cujo único atributo de busca é `application` (`chrome`,
//! `msedge`, `brave`, `opera`, `chromium`…). O `keyring` só casa itens por `service` + `username`, então a busca
//! usa a biblioteca que ele mesmo usa por baixo (`secret-service`), com o mesmo critério do helper do T3 Code
//! (`native/browser-secret/main.c`): só o atributo `application`, sem nome de esquema, porque itens gravados por
//! versões antigas do libgnome-keyring não têm esquema.
//!
//! Só roda no clique de confirmar a gravação. Se o item está trancado, o desbloqueio normal da área de trabalho
//! aparece (é o que o usuário vê); cancelar ou negar vira `needs-keychain-approval`. A senha volta em bytes,
//! nunca passa por log e o chamador a zera depois de derivar a chave.

use std::collections::HashMap;

use secret_service::blocking::SecretService;
use secret_service::{EncryptionType, Error};

use super::ImportError;

/// O código estável de cada falha, no mesmo mapa de códigos de saída do helper do T3 (2 ausente, 3 trancado,
/// 4 indisponível).
pub(crate) fn map_error(error: &Error) -> ImportError {
    match error {
        // Trancado, ou o pedido de desbloqueio foi cancelado: falta de aprovação da pessoa.
        Error::Locked | Error::Prompt => ImportError::new("needs-keychain-approval"),
        Error::NoResult => ImportError::new("keychain-item-missing"),
        // Sem serviço de segredos na sessão (sem D-Bus, sem GNOME Keyring/KWallet).
        Error::Unavailable => ImportError::new("keychain-unavailable"),
        // O `zbus` não é dependência direta: o `AccessDenied` do D-Bus só se reconhece pelo nome no `Debug`.
        // O detalhe do erro nunca traz a senha.
        other if format!("{other:?}").contains("AccessDenied") => ImportError::new("needs-keychain-approval"),
        _ => ImportError::new("keychain-unavailable"),
    }
}

/// A senha do item com `application = <application>`. Item ausente ou vazio: `keychain-item-missing`.
pub(crate) fn read_chromium_secret(application: &str) -> Result<Vec<u8>, ImportError> {
    let service = SecretService::connect(EncryptionType::Dh).map_err(|e| map_error(&e))?;
    let found = service.search_items(HashMap::from([("application", application)])).map_err(|e| map_error(&e))?;
    // Prefere um item já destrancado; senão o primeiro trancado, que o desbloqueio normal do sistema abre.
    let item = found
        .unlocked
        .iter()
        .chain(found.locked.iter())
        .next()
        .ok_or_else(|| ImportError::new("keychain-item-missing"))?;
    if item.is_locked().map_err(|e| map_error(&e))? {
        item.unlock().map_err(|e| map_error(&e))?;
        // Um desbloqueio cancelado pode devolver o item ainda trancado: conferir antes de ler.
        if item.is_locked().map_err(|e| map_error(&e))? {
            return Err(ImportError::new("needs-keychain-approval"));
        }
    }
    let secret = item.get_secret().map_err(|e| map_error(&e))?;
    if secret.is_empty() {
        return Err(ImportError::new("keychain-item-missing"));
    }
    Ok(secret)
}
