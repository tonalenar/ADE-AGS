//! Account-scoped Cloud Code discovery. This is not an inference executor.
use serde::Serialize;
use serde_json::{Value, json};
use std::time::Duration;
use tauri::AppHandle;

const BASE: &str = "https://cloudcode-pa.googleapis.com/v1internal:";
const MAX_RESPONSE: usize = 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    account_id: String,
    project_id: String,
    models: Vec<Model>,
    inference_verified: bool,
}

fn project(data: &Value) -> Result<String, String> {
    let value = &data["cloudaicompanionProject"];
    let id = value
        .as_str()
        .or_else(|| value["id"].as_str())
        .unwrap_or("");
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err("Antigravity não retornou um projeto válido para esta conta".into());
    }
    Ok(id.to_owned())
}

fn models(data: &Value) -> Result<Vec<Model>, String> {
    let entries = data["models"]
        .as_object()
        .ok_or("Antigravity retornou um catálogo inválido")?;
    if entries.len() > 1024 {
        return Err("O catálogo excedeu o limite de modelos".into());
    }
    let mut rows = Vec::with_capacity(entries.len());
    for (id, info) in entries {
        if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
            return Err("O catálogo contém um identificador de modelo inválido".into());
        }
        let name = info["displayName"]
            .as_str()
            .filter(|s| s.len() <= 512 && !s.chars().any(char::is_control))
            .unwrap_or(id);
        rows.push(Model {
            id: id.clone(),
            name: name.to_owned(),
        });
    }
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(rows)
}

fn http_error(status: u16) -> String {
    match status {
        401 => "O login desta conta expirou ou foi recusado. Reconecte a conta.".into(),
        403 => "O serviço Antigravity recusou o acesso desta conta ou deste cliente OAuth.".into(),
        429 => "O serviço limitou as consultas desta conta. Tente novamente mais tarde.".into(),
        _ => format!("Falha ao consultar Antigravity (HTTP {status})"),
    }
}

async fn post(
    client: &reqwest::Client,
    token: &str,
    action: &str,
    payload: Value,
) -> Result<Value, String> {
    // The URL is fixed by the backend; no redirects or caller-supplied destination.
    let mut response = client
        .post(format!("{BASE}{action}"))
        .bearer_auth(token)
        .header(reqwest::header::USER_AGENT, "ADE-AGS/1.8.7")
        .json(&payload)
        .send()
        .await
        .map_err(|_| "Falha de conexão com Antigravity")?;
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Falha ao receber resposta Antigravity")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("Resposta Antigravity excedeu o limite".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Resposta Antigravity inválida".into())
}

#[tauri::command]
pub async fn antigravity_account_discovery(
    account_id: String,
    app: AppHandle,
) -> Result<Discovery, String> {
    // Verify identity for this exact account before using its grant. Never use agy login.
    super::antigravity_oauth::antigravity_oauth_verify(account_id.clone(), app).await?;
    let grant = super::antigravity_oauth::refreshed_grant(&account_id).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cliente Antigravity indisponível")?;
    let info = post(&client, &grant.access_token, "loadCodeAssist", json!({
        "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "PLUGIN_UNSPECIFIED" }
    })).await?;
    let project_id = project(&info)?;
    let catalogue = post(
        &client,
        &grant.access_token,
        "fetchAvailableModels",
        json!({"project": project_id}),
    )
    .await?;
    Ok(Discovery {
        account_id,
        project_id,
        models: models(&catalogue)?,
        inference_verified: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_accepts_both_formats_and_rejects_missing_identity() {
        assert_eq!(
            project(&json!({"cloudaicompanionProject":"project-a"})).unwrap(),
            "project-a"
        );
        assert_eq!(
            project(&json!({"cloudaicompanionProject":{"id":"project-b"}})).unwrap(),
            "project-b"
        );
        assert!(project(&json!({})).is_err());
        assert!(project(&json!({"cloudaicompanionProject":"a\nb"})).is_err());
    }
    #[test]
    fn account_catalogues_are_independent_and_sorted() {
        let a = models(&json!({"models":{"z":{},"a":{"displayName":"A"}}})).unwrap();
        let b = models(&json!({"models":{"other":{}}})).unwrap();
        assert_eq!(
            a.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "z"]
        );
        assert_eq!(b[0].id, "other");
        assert!(models(&json!({"models":["fake"]})).is_err());
    }
    #[test]
    fn discovery_contains_no_grant_and_does_not_claim_inference() {
        let value = serde_json::to_value(Discovery {
            account_id: "a".into(),
            project_id: "p".into(),
            models: vec![],
            inference_verified: false,
        })
        .unwrap();
        assert_eq!(value["inferenceVerified"], false);
        for field in ["access_token", "refresh_token", "client_secret"] {
            assert!(value.get(field).is_none());
        }
        assert!(http_error(403).contains("recusou"));
    }
}
