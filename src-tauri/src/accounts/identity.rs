//! Identidade visual de uma conta: o nome que a pessoa vê e a cor do selo.
//!
//! O `name` da conta é o nome da pasta do perfil e não muda; aqui moram só `display_name` e
//! `accent_color`. A cor é o NOME de um token do tema (`green`, `orange`…), nunca um hex: a
//! UI resolve o token para `var(--color-<nome>-…)`, e assim o selo acompanha o tema.
//!
//! A conta principal (a do sistema, `system:<agente>`) não é uma linha da tabela: a
//! identidade dela fica na configuração, uma chave por agente.

use super::profiles::spec_for;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Os tokens aceitos. Precisa casar com `ACCOUNT_COLORS` em `accountIdentity.ts`.
pub const ACCENT_TOKENS: &[&str] = &[
    "blue", "violet", "orange", "green", "pink", "yellow", "cyan", "red",
];

const MAX_DISPLAY_NAME: usize = 40;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub accent_color: Option<String>,
}

/// Apara o nome e devolve `None` se ficou vazio (limpar volta ao padrão).
pub fn normalize_display_name(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(name) = raw.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    if name.chars().count() > MAX_DISPLAY_NAME {
        return Err(format!(
            "O nome não pode ter mais de {MAX_DISPLAY_NAME} caracteres"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("O nome não pode ter quebra de linha nem caracteres de controle".into());
    }
    Ok(Some(name.to_string()))
}

/// A cor tem de ser um token da paleta; vazio limpa.
pub fn normalize_accent(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(token) = raw.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if ACCENT_TOKENS.contains(&token) {
        Ok(Some(token.to_string()))
    } else {
        Err(format!("Cor desconhecida: '{token}'"))
    }
}

/// A chave de configuração da conta principal de um agente.
pub fn system_identity_key(agent_id: &str) -> String {
    format!("accounts.system_identity.{agent_id}")
}

/// A identidade guardada da conta principal. Valor ausente ou corrompido vira o padrão.
pub fn load_system_identity(conn: &Connection, agent_id: &str) -> AccountIdentity {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [system_identity_key(agent_id)],
            |row| row.get(0),
        )
        .ok();
    let Some(identity) = raw.and_then(|r| serde_json::from_str::<AccountIdentity>(&r).ok()) else {
        return AccountIdentity::default();
    };
    // Revalida na leitura: um valor editado à mão não pode injetar um token desconhecido.
    AccountIdentity {
        display_name: normalize_display_name(identity.display_name.as_deref()).unwrap_or(None),
        accent_color: normalize_accent(identity.accent_color.as_deref()).unwrap_or(None),
    }
}

/// Grava nome e cor de uma conta (linha da tabela ou `system:<agente>`). Nunca mexe no
/// nome da pasta nem no login.
pub fn set_identity(
    conn: &Connection,
    account_id: &str,
    display_name: Option<&str>,
    accent_color: Option<&str>,
) -> Result<AccountIdentity, String> {
    let identity = AccountIdentity {
        display_name: normalize_display_name(display_name)?,
        accent_color: normalize_accent(accent_color)?,
    };
    if let Some(agent_id) = account_id.strip_prefix("system:") {
        if spec_for(agent_id).is_none() {
            return Err(format!("'{agent_id}' não suporta várias contas"));
        }
        let key = system_identity_key(agent_id);
        if identity == AccountIdentity::default() {
            conn.execute("DELETE FROM settings WHERE key = ?1", [&key])
                .map_err(|e| e.to_string())?;
        } else {
            let value = serde_json::to_string(&identity).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(identity);
    }
    let changed = conn
        .execute(
            "UPDATE agent_accounts SET display_name = ?2, accent_color = ?3 WHERE id = ?1",
            rusqlite::params![account_id, identity.display_name, identity.accent_color],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("A conta não existe mais.".into());
    }
    Ok(identity)
}
