//! A cota do login local do Antigravity, lida do próprio CLI: `agy -p /usage --output-format json`.
//!
//! É o comando `/usage` do `agy`, não um prompt: responde com `num_turns` 0 e nenhum token, e traz
//! os grupos de modelos (Gemini, Claude/GPT, Argon…) com as janelas semanal e de 5 horas. Fala só
//! pelo login que o `agy` tem nesta máquina — as contas OAuth da ADE seguem por
//! `antigravity_access` (`fetchAvailableModels`).
//!
//! O `agy` é chamado direto, sem shell: um shell MSYS transforma `/usage` em caminho e o CLI
//! recebe um prompt de verdade, que gasta cota.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const KEY: &str = "usage.antigravity.cli.v1";
const TIMEOUT: Duration = Duration::from_secs(90);
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_GROUPS: usize = 32;
const MAX_WINDOWS: usize = 16;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgyWindow {
    pub id: String,
    /// `weekly`, `session` (5 h), `daily`, `monthly` ou `other`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
    /// Quanto já foi USADO, 0–100. O CLI informa o que resta.
    pub used_pct: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgyGroup {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub windows: Vec<AgyWindow>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgyUsage {
    /// `false` = não há `agy` no PATH; o painel não mostra a seção.
    pub installed: bool,
    pub groups: Vec<AgyGroup>,
    /// Epoch segundos da última leitura boa. 0 = nenhuma ainda.
    #[serde(default)]
    pub fetched_at: i64,
    /// Veio do SQLite, sem rodar o CLI.
    #[serde(default)]
    pub cached: bool,
}

fn clean(s: &str, max: usize) -> Option<String> {
    let s = s.trim();
    (!s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)).then(|| s.to_owned())
}

/// `weekly`, `5h`, `daily`… → o tipo e a duração. Desconhecido = `other`, sem duração. Pura.
fn window_kind(name: &str) -> (&'static str, Option<u64>) {
    match name.to_ascii_lowercase().as_str() {
        "weekly" | "week" | "7d" | "usage_period_type_weekly" => ("weekly", Some(604_800)),
        "5h" | "five_hour" | "fivehour" => ("session", Some(18_000)),
        "daily" | "day" | "1d" => ("daily", Some(86_400)),
        "monthly" | "month" | "usage_period_type_monthly" => ("monthly", Some(2_592_000)),
        _ => ("other", None),
    }
}

/// A saída do `agy /usage` → grupos. Tolerante por campo (um bucket estranho some), estrito no
/// envelope: sem `command.data.groups` não é a resposta do `/usage` e vira erro. Pura.
pub fn parse(stdout: &str) -> Result<Vec<AgyGroup>, String> {
    let start = stdout.find('{').ok_or("O agy não devolveu JSON")?;
    let end = stdout.rfind('}').ok_or("O agy não devolveu JSON")?;
    let doc: Value = serde_json::from_str(&stdout[start..=end]).map_err(|_| "O agy devolveu um JSON inválido")?;
    if doc["status"].as_str() != Some("SUCCESS") {
        return Err("O agy não conseguiu ler a cota (status diferente de SUCCESS)".into());
    }
    let groups = doc["command"]["data"]["groups"]
        .as_array()
        .ok_or("Esta versão do agy não respondeu ao /usage. Atualize o CLI do Antigravity.")?;
    let mut out = Vec::new();
    for g in groups.iter().take(MAX_GROUPS) {
        let Some(name) = g["name"].as_str().and_then(|s| clean(s, 128)) else { continue };
        let windows: Vec<AgyWindow> = g["buckets"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .take(MAX_WINDOWS)
            .filter_map(|b| {
                let remaining = b["remaining_fraction"].as_f64().filter(|f| f.is_finite())?.clamp(0.0, 1.0);
                let id = b["id"].as_str().and_then(|s| clean(s, 128))?;
                let (kind, duration_seconds) = window_kind(b["window"].as_str().unwrap_or(""));
                Some(AgyWindow {
                    id,
                    kind: kind.into(),
                    duration_seconds,
                    used_pct: (1.0 - remaining) * 100.0,
                    resets_at: b["reset_time"].as_str().and_then(|s| clean(s, 64)),
                })
            })
            .collect();
        if windows.is_empty() {
            continue;
        }
        out.push(AgyGroup { name, description: g["description"].as_str().and_then(|s| clean(s, 512)), windows });
    }
    Ok(out)
}

/// Roda o `/usage`. Bloqueante: chamar de `spawn_blocking`.
fn run(program: &std::path::Path) -> Result<Vec<AgyGroup>, String> {
    let mut cmd = crate::util::spawn::hidden_command(program);
    cmd.args(["-p", "/usage", "--output-format", "json"])
        // As mesmas que o Maestri limpa: credencial por variável apontaria para outra conta.
        .env_remove("JETSKI_OAUTH_TOKEN")
        .env_remove("AGY_ADC_AUTH")
        .env_remove("GEMINI_API_KEY")
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null());
    let out = crate::util::spawn::output(&mut cmd, TIMEOUT).map_err(|e| match e.kind() {
        std::io::ErrorKind::TimedOut => "O agy demorou demais para responder ao /usage".to_string(),
        _ => "Não foi possível iniciar o agy".to_string(),
    })?;
    if out.stdout.len() > MAX_OUTPUT {
        return Err("A resposta do agy excedeu o limite".into());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    match parse(&stdout) {
        Ok(groups) => Ok(groups),
        Err(e) if !out.status.success() => Err(format!("{e} (código {})", out.status.code().unwrap_or(-1))),
        Err(e) => Err(e),
    }
}

/// `force` ausente = ao vivo. O canvas manda `false` para reusar a última leitura guardada.
#[tauri::command]
pub async fn antigravity_cli_usage(
    force: Option<bool>,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<AgyUsage, String> {
    let Some(program) = crate::util::find_program("agy") else {
        return Ok(AgyUsage { installed: false, groups: Vec::new(), fetched_at: 0, cached: false });
    };
    let db = (*db).clone();
    if !force.unwrap_or(true) {
        let stored = crate::database::get_setting(&db, KEY).ok().flatten().and_then(|raw| {
            let mut stored = serde_json::from_str::<AgyUsage>(&raw).ok()?;
            stored.cached = true;
            Some(stored)
        });
        return Ok(stored.unwrap_or(AgyUsage { installed: true, groups: Vec::new(), fetched_at: 0, cached: false }));
    }
    let groups = tokio::task::spawn_blocking(move || run(&program)).await.map_err(|e| e.to_string())??;
    let found = AgyUsage { installed: true, groups, fetched_at: crate::util::now_ts(), cached: false };
    if let Ok(raw) = serde_json::to_string(&found) {
        let _ = crate::database::set_setting(&db, KEY, &raw);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"conversation_id":"x","status":"SUCCESS","num_turns":0,
      "command":{"name":"usage","data":{"groups":[
        {"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[
          {"id":"gemini-weekly","window":"weekly","remaining_fraction":0.921504020690918,"reset_time":"2026-10-31T12:35:00Z"},
          {"id":"gemini-5h","window":"5h","remaining_fraction":1,"reset_time":"2026-10-27T17:23:10Z"}]},
        {"name":"Gemini 4 Argon","buckets":[{"id":"argon-weekly","window":"weekly","remaining_fraction":1}]}
      ]}}}"#;

    #[test]
    fn le_grupos_e_janelas_do_usage() {
        let groups = parse(SAMPLE).unwrap();
        assert_eq!(groups.len(), 2);
        let w = &groups[0].windows;
        assert_eq!((w[0].kind.as_str(), w[0].duration_seconds), ("weekly", Some(604_800)));
        assert!((w[0].used_pct - 7.8496).abs() < 0.001);
        assert_eq!((w[1].kind.as_str(), w[1].used_pct), ("session", 0.0));
        assert_eq!(groups[1].windows[0].resets_at, None);
        assert!(groups[0].description.as_deref().unwrap().contains("Gemini Pro"));
    }

    #[test]
    fn resposta_de_prompt_nao_e_cota() {
        // O que sai quando `/usage` chega como prompt (MSYS) ou o CLI é antigo.
        let prompt = r#"{"status":"SUCCESS","num_turns":1,"response":"","usage":{"total_tokens":7740}}"#;
        assert!(parse(prompt).unwrap_err().contains("Atualize"));
        assert!(parse(r#"{"status":"ERROR","command":{"data":{"groups":[]}}}"#).is_err());
        assert!(parse("sem json").is_err());
    }

    #[test]
    fn bucket_estranho_some_e_o_resto_fica() {
        let doc = r#"{"status":"SUCCESS","command":{"data":{"groups":[
          {"name":"A","buckets":[{"id":"ok","window":"7d","remaining_fraction":3},{"id":"x","remaining_fraction":"n"},{"window":"5h","remaining_fraction":0.5}]},
          {"name":"Vazio","buckets":[]},{"buckets":[{"id":"sem-nome","remaining_fraction":0.1}]}]}}}"#;
        let groups = parse(doc).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].windows.len(), 1);
        assert_eq!(groups[0].windows[0].used_pct, 0.0);
        assert_eq!(window_kind("mystery"), ("other", None));
    }

    /// Contra o `agy` desta máquina: `cargo test --lib usage::agy -- --ignored`. Não gasta tokens.
    #[test]
    #[ignore]
    fn ao_vivo_le_o_login_local() {
        let program = crate::util::find_program("agy").expect("agy no PATH");
        let groups = run(&program).unwrap();
        assert!(!groups.is_empty());
        assert!(groups.iter().all(|g| g.windows.iter().all(|w| (0.0..=100.0).contains(&w.used_pct))));
    }

    #[test]
    fn json_com_texto_em_volta_ainda_e_lido() {
        assert_eq!(parse(&format!("aviso qualquer\n{SAMPLE}\n")).unwrap().len(), 2);
    }
}
