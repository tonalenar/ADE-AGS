//! As versões do Jev e a atualização automática do modelo.
//!
//! O Jev publica versões (`jev-1.13.0`, `jev-1.14.0`…) e os apelidos `jev-latest`/`jev-preview`. Quem fixa uma
//! versão fica nela para sempre, a menos que "Atualizar o modelo sozinho" esteja ligado (o padrão): aí, ao abrir o
//! app e uma vez por dia, ele descobre a versão mais nova e passa para ela. `GET /v1/models` só lista os apelidos
//! (visto em 20/10/2026), então a versão vem de um ping mínimo ao `jev-latest`: a resposta diz qual versão
//! respondeu. Sem rede, vale a mais nova que esta versão do app conhece (`NEWEST_KNOWN`).

use std::time::Duration;

use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::database::DbConnection;

use super::config::{self, ProviderKind};

/// A versão mais nova que este app conhece. Vale também sem rede.
pub const NEWEST_KNOWN: &str = "jev-1.14.0";
/// As versões que o Jev listou na última consulta (JSON, lista de nomes).
pub const KEY_SEEN: &str = "decisions.jev_models_seen";
/// De quanto em quanto tempo se pergunta de novo.
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Evento que avisa a tela que o modelo mudou sozinho (o payload é o nome novo).
pub const UPDATED_EVENT: &str = "decisions-model-updated";

/// `jev-1.14.0` → (1, 14, 0). Um apelido (`jev-latest`) ou outro nome → `None`. Pura.
pub fn version(model: &str) -> Option<(u32, u32, u32)> {
    let rest = model.trim().strip_prefix("jev-")?;
    let mut parts = rest.split('.').map(|part| part.parse::<u32>().ok());
    let (Some(Some(a)), Some(Some(b)), Some(Some(c)), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    Some((a, b, c))
}

/// A versão mais nova entre os candidatos. Pura.
pub fn newest<'a>(candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    candidates.into_iter().filter_map(|name| version(name).map(|v| (v, name))).max_by_key(|(v, _)| *v).map(|(_, name)| name)
}

/// Para qual versão o modelo fixado deve ir, se houver uma mais nova. Um apelido nunca muda (o Jev já resolve).
/// Pura.
pub fn upgrade_for(current: &str, candidates: &[&str]) -> Option<String> {
    let now = version(current)?;
    let best = newest(candidates.iter().copied())?;
    (version(best)? > now).then(|| best.to_string())
}

/// Os nomes de modelo numa resposta de `/v1/models`, aceitando os formatos comuns: uma lista, `{data: [...]}` ou
/// `{models: [...]}`, com nomes soltos ou objetos com `id`/`name`/`model`. Só os do Jev. Pura.
pub fn parse_models(body: &Value) -> Vec<String> {
    let list = body
        .as_array()
        .or_else(|| body.get("data").and_then(Value::as_array))
        .or_else(|| body.get("models").and_then(Value::as_array));
    let mut names: Vec<String> = list
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str()
                .or_else(|| ["id", "name", "model"].iter().find_map(|key| item.get(key).and_then(Value::as_str)))
                .map(str::trim)
                .filter(|name| name.starts_with("jev-"))
                .map(str::to_string)
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// As versões que valem como candidatas: as que o Jev listou por último e a mais nova conhecida.
pub fn candidates(conn: &Connection) -> Vec<String> {
    let mut all: Vec<String> = config::stored_text(conn, KEY_SEEN)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default();
    all.push(NEWEST_KNOWN.to_string());
    all.sort();
    all.dedup();
    all
}

/// Pergunta ao Jev quais modelos existem. `None` sem chave, sem rede ou com resposta estranha.
fn fetch(base_url: &str, key: &str) -> Option<Vec<String>> {
    let client = super::http::client().ok()?;
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let response = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .timeout(Duration::from_secs(10))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let names = parse_models(&response.json::<Value>().ok()?);
    (!names.is_empty()).then_some(names)
}

/// A versão que responde pelo `jev-latest` agora: o mesmo pedido mínimo do "Testar conexão", e a resposta diz
/// qual versão respondeu. `None` sem rede ou se a resposta não traz uma versão.
fn latest_version(settings: &config::Settings, key: &str) -> Option<String> {
    let mut probe = settings.clone();
    probe.model = "jev-latest".into();
    probe.timeout_ms = probe.timeout_ms.max(5_000);
    let answered = super::http::execute(&probe, Some(key), &super::protocol::ping_request("jev-latest")).ok()?.model;
    version(&answered).map(|_| answered)
}

/// O Jev aceita este nome de modelo? (O ping mínimo; um nome que não existe volta `400 Unknown model`.)
fn accepts(settings: &config::Settings, key: &str, model: &str) -> bool {
    let mut probe = settings.clone();
    probe.model = model.into();
    probe.timeout_ms = probe.timeout_ms.max(5_000);
    super::http::execute(&probe, Some(key), &super::protocol::ping_request(model)).is_ok()
}

/// As versões depois de `from` que existem: tenta a próxima minor, a próxima patch e a próxima major, e segue da
/// que existir (até 5 saltos). Pura, com `exists` como a pergunta ao Jev.
pub fn probe_next(from: &str, mut exists: impl FnMut(&str) -> bool) -> Vec<String> {
    let mut found = Vec::new();
    let Some(mut at) = version(from) else { return found };
    for _ in 0..5 {
        let (a, b, c) = at;
        let next = [(a, b + 1, 0), (a, b, c + 1), (a + 1, 0, 0)]
            .into_iter()
            .map(|(x, y, z)| (format!("jev-{x}.{y}.{z}"), (x, y, z)))
            .find(|(name, _)| exists(name));
        let Some((name, v)) = next else { break };
        found.push(name);
        at = v;
    }
    found
}

/// Uma rodada: atualiza a lista vista e, se for o caso, o modelo. Devolve o modelo novo quando mudou.
pub fn refresh(db: &DbConnection) -> Option<String> {
    let settings = {
        let conn = db.lock().ok()?;
        config::load(&conn).ok()?
    };
    if settings.provider != ProviderKind::Jev {
        return None;
    }
    if let Some(key) = config::load_key_in(config::KeySlot::Primary) {
        let mut names = fetch(&settings.base_url, &key).unwrap_or_default();
        // A lista só traz apelidos: a versão por trás do `jev-latest` vem da resposta de um ping mínimo.
        if let Some(latest) = latest_version(&settings, &key) {
            names.push(latest);
        }
        // E o `jev-latest` pode ficar para trás de uma versão já publicada (em 20/10/2026 ele respondia 1.13 com a
        // 1.14 no ar): sonda as próximas a partir da mais nova conhecida. Um nome que não existe volta 400.
        let known = {
            let conn = db.lock().ok()?;
            candidates(&conn)
        };
        let start = newest(known.iter().chain(names.iter()).map(String::as_str)).map(str::to_string);
        if let Some(start) = start {
            names.extend(probe_next(&start, |model| accepts(&settings, &key, model)));
        }
        names.sort();
        names.dedup();
        if !names.is_empty() {
            let conn = db.lock().ok()?;
            let _ = config::store_text(&conn, KEY_SEEN, &serde_json::to_string(&names).unwrap_or_default());
        }
    }
    let conn = db.lock().ok()?;
    let before = settings.model.clone();
    // `load` aplica a atualização (com a lista recém-vista) e grava o modelo novo.
    let after = config::load(&conn).ok()?.model;
    (after != before).then_some(after)
}

/// Ao abrir o app e depois uma vez por dia. Fora da thread principal: a consulta vai à rede.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(db) = app.try_state::<DbConnection>() {
            if let Some(model) = refresh(db.inner()) {
                eprintln!("[decisions] modelo do Jev atualizado sozinho para {model}");
                let _ = app.emit(UPDATED_EVENT, &model);
            }
        }
        std::thread::sleep(EVERY);
    });
}

/// Os modelos que o seletor oferece para o Jev: os apelidos e as versões conhecidas, a mais nova primeiro.
#[tauri::command]
pub fn decision_jev_models(db: tauri::State<DbConnection>) -> Result<Vec<String>, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    let mut versions: Vec<String> = candidates(&conn).into_iter().filter(|name| version(name).is_some()).collect();
    versions.sort_by_key(|name| std::cmp::Reverse(version(name)));
    Ok(["jev-latest".to_string(), "jev-preview".to_string()].into_iter().chain(versions).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn so_versoes_do_jev_contam() {
        assert_eq!(version("jev-1.14.0"), Some((1, 14, 0)));
        assert_eq!(version("jev-latest"), None);
        assert_eq!(version("jev-1.14"), None);
        assert_eq!(version("jev-1.14.0.1"), None);
        assert_eq!(version("multilingual"), None);
    }

    #[test]
    fn a_versao_fixada_sobe_para_a_mais_nova_e_apelido_fica() {
        assert_eq!(upgrade_for("jev-1.13.0", &["jev-1.13.0", "jev-1.14.0"]), Some("jev-1.14.0".into()));
        // 1.10 > 1.9: a comparação é numérica, não de texto.
        assert_eq!(upgrade_for("jev-1.9.0", &["jev-1.10.0"]), Some("jev-1.10.0".into()));
        assert_eq!(upgrade_for("jev-1.14.0", &["jev-1.13.0", "jev-1.14.0"]), None);
        assert_eq!(upgrade_for("jev-latest", &["jev-1.14.0"]), None);
    }

    #[test]
    fn sonda_as_proximas_versoes_ate_nao_haver_mais() {
        let published = ["jev-1.15.0", "jev-1.15.1", "jev-2.0.0"];
        let mut asked = Vec::new();
        let found = probe_next("jev-1.14.0", |name| {
            asked.push(name.to_string());
            published.contains(&name)
        });
        assert_eq!(found, vec!["jev-1.15.0", "jev-1.15.1", "jev-2.0.0"]);
        // Sem nada novo: três perguntas e para.
        let mut count = 0;
        assert!(probe_next("jev-1.14.0", |_| { count += 1; false }).is_empty());
        assert_eq!(count, 3);
        assert!(probe_next("jev-latest", |_| true).is_empty());
    }

    #[test]
    fn le_os_formatos_comuns_de_lista_de_modelos() {
        assert_eq!(parse_models(&json!({"data": [{"id": "jev-1.14.0"}, {"id": "jev-latest"}, {"id": "gpt-x"}]})), vec!["jev-1.14.0", "jev-latest"]);
        assert_eq!(parse_models(&json!({"models": ["jev-1.13.0", "jev-1.14.0"]})), vec!["jev-1.13.0", "jev-1.14.0"]);
        assert_eq!(parse_models(&json!([{"name": "jev-preview"}])), vec!["jev-preview"]);
        assert!(parse_models(&json!({"detail": "erro"})).is_empty());
    }
}

#[cfg(test)]
mod load_tests {
    use rusqlite::Connection;

    use super::super::config;
    use super::{KEY_SEEN, NEWEST_KNOWN};

    fn db(model: &str, auto: Option<&str>) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        config::store_text(&conn, config::KEY_PROVIDER, "jev").unwrap();
        config::store_text(&conn, config::KEY_MODEL, model).unwrap();
        if let Some(auto) = auto {
            config::store_text(&conn, config::KEY_MODEL_AUTO, auto).unwrap();
        }
        conn
    }

    #[test]
    fn versao_fixada_sobe_sozinha_e_fica_gravada() {
        // Nunca gravado = ligado: a 1.13 fixada passa para a mais nova que o app conhece.
        let conn = db("jev-1.13.0", None);
        assert_eq!(config::load(&conn).unwrap().model, NEWEST_KNOWN);
        assert_eq!(config::stored_text(&conn, config::KEY_MODEL).as_deref(), Some(NEWEST_KNOWN));
        // Uma versão que o Jev listou e o app ainda não conhecia também vale (e não volta para jev-latest).
        config::store_text(&conn, KEY_SEEN, r#"["jev-1.13.0","jev-1.15.2"]"#).unwrap();
        assert_eq!(config::load(&conn).unwrap().model, "jev-1.15.2");
    }

    #[test]
    fn desligado_ou_apelido_nao_mudam() {
        assert_eq!(config::load(&db("jev-1.13.0", Some("false"))).unwrap().model, "jev-1.13.0");
        assert_eq!(config::load(&db("jev-latest", None)).unwrap().model, "jev-latest");
    }
}
