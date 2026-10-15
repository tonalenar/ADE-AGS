//! A reserva VISUAL do piloto do navegador (`browse.rs`): quando o texto da página não basta — um ícone sem nome, uma
//! página feita de canvas —, o Jev olha uma FOTO dela e aponta onde tocar com uma pergunta do tipo `box` (a caixa que
//! envolve o alvo, em frações da imagem). É o recurso experimental de imagens do Jev 1.14.
//!
//! Uma só consulta leva duas perguntas sobre a mesma foto: `existe` ("há na foto um controle que avança o objetivo?",
//! sim/não) e `alvo` (o `box`). Um `box` SEMPRE devolve uma caixa, mesmo sem alvo, então quem decide se há algo
//! para tocar é a pergunta `existe`.
//!
//! As regras são as do piloto de texto, e mais as de uma imagem:
//!
//! - fica DESLIGADO por padrão e à parte (`decisions.point.browser_vision`): a foto sai da máquina e o detector de
//!   segredos NÃO lê imagens (o frontend não a usa se há um campo de senha, cartão ou token preenchido);
//! - só se lê uma captura que o próprio app salvou (a pasta das capturas), nunca um caminho qualquer;
//! - o cabeçalho `TypeSafe-Danger-Zone-Images: true` e o modelo `jev-preview` (o 1.14, o único com `box`);
//! - cada consulta vira uma linha do log (`browser_vision`).

use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::database::DbConnection;
use crate::util::now_ts;

use super::config::{self, ProviderKind};
use super::http;
use super::log::{self, LogRow};
use super::points::{memory_secret, POINT_BROWSE_VISION};
use super::protocol::truncate_chars;

/// O único modelo com `box` e imagens: o 1.14, que ainda é a prévia.
const VISION_MODEL: &str = "jev-preview";
const IMAGES_HEADER: &str = "TypeSafe-Danger-Zone-Images";
/// Uma foto maior que isto não vai: o corte é do app, não do Jev.
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const STATE_BYTES: usize = 6_000;
/// A faixa de ÁREA (largura × altura) que o Jev aceita, medida com a chamada real: 500×300 passa e 485×258 não;
/// 1500×900 passa e 1600×960 não. O app redimensiona antes (`visualSize.ts`); isto é só a rede de proteção.
const MIN_AREA: u64 = 135_000;
const MAX_AREA: u64 = 1_480_000;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualQuery {
    pub goal: String,
    /// As últimas ações, em texto (nunca valores digitados).
    #[serde(default)]
    pub recent: String,
    /// A captura que o app salvou (`preview_save_capture`).
    pub image_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Rect {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

impl Rect {
    /// O centro, em frações da imagem: é onde se toca.
    pub fn center(&self) -> (f64, f64) {
        ((self.left + self.right) / 2.0, (self.top + self.bottom) / 2.0)
    }

    /// Uma caixa que cabe na imagem e tem área.
    fn valid(&self) -> bool {
        [self.left, self.right, self.top, self.bottom].iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v))
            && self.right > self.left
            && self.bottom > self.top
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualReply {
    /// `ok`, `off`, `secret` ou `error`.
    pub status: &'static str,
    /// O Jev viu um controle na foto que avança o objetivo?
    pub found: Option<bool>,
    pub found_probability: Option<f64>,
    /// Onde, em frações da imagem (só com `found`).
    pub rect: Option<Rect>,
    pub center: Option<(f64, f64)>,
    /// A confiança do `box`.
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub latency_ms: Option<u64>,
}

impl VisualReply {
    fn without(status: &'static str, reason: impl Into<String>) -> Self {
        Self { status, found: None, found_probability: None, rect: None, center: None, confidence: None, reason: Some(reason.into()), latency_ms: None }
    }
}

fn instructions_exists(goal: &str) -> String {
    format!(
        "Look at `photo`, a screenshot of a web page. The user's goal is: {goal} Is there ONE visible control (button, link, icon, field or menu item) \
that is the right next thing to tap to advance that goal? Answer no if the goal already looks done, or if the right control is not on the screen."
    )
}

fn instructions_target(goal: &str) -> String {
    format!(
        "The single control in `photo` (a screenshot of a web page) that is the right next thing to tap to advance this goal: {goal} \
Use the recent actions in the state: do not choose something already done."
    )
}

/// O corpo JSON do pedido: a imagem entra por `assets`/`state`, como no exemplo do `box` da documentação. Pura.
pub fn request_body(query: &VisualQuery) -> Value {
    let recent = if query.recent.trim().is_empty() { "none yet".to_string() } else { truncate_chars(query.recent.trim(), STATE_BYTES) };
    json!({
        "model": VISION_MODEL,
        "state": { "goal": truncate_chars(query.goal.trim(), STATE_BYTES), "recent_actions": recent, "photo": "screenshot-1" },
        "assets": { "screenshot-1": { "type": "image", "part": "screenshot" } },
        "questions": {
            "existe": {
                "type": "choice",
                "instructions": instructions_exists(query.goal.trim()),
                "criteria": { "yes": "There is a visible control that is the right next tap.", "no": "There is not." },
            },
            "alvo": { "type": "box", "instructions": instructions_target(query.goal.trim()) },
        },
    })
}

/// O corpo `multipart/form-data`: a parte `request` (JSON) e a foto. Feito à mão para não puxar mais uma dependência. Pura.
pub fn multipart(boundary: &str, request: &Value, png: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(png.len() + 1024);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json\r\n\r\n").as_bytes());
    body.extend_from_slice(request.to_string().as_bytes());
    body.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"screenshot\"; filename=\"screenshot.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
    body.extend_from_slice(png);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Lê a resposta: `existe` (sim/não, com a probabilidade) e `alvo` (a caixa e a confiança). Pura.
pub fn read_reply(text: &str) -> Result<(bool, Option<f64>, Option<Rect>, Option<f64>), String> {
    let value: Value = serde_json::from_str(text).map_err(|_| "A resposta do Jev não é um JSON.".to_string())?;
    let answers = value.get("answers").ok_or("A resposta do Jev veio sem respostas.")?;
    let exists = answers.get("existe").ok_or("O Jev não respondeu se há algo para tocar.")?;
    let choice = exists.get("choice").and_then(Value::as_str).ok_or("A resposta de existência veio sem escolha.")?;
    let found = match choice {
        "yes" => true,
        "no" => false,
        _ => return Err("O Jev respondeu algo que não é sim nem não.".into()),
    };
    let found_probability = exists.get("probabilities").and_then(|p| p.get(choice)).and_then(Value::as_f64);
    let target = answers.get("alvo");
    let rect = target.and_then(|t| t.get("box")).and_then(|b| {
        let edge = |name: &str| b.get(name).and_then(Value::as_f64);
        Some(Rect { left: edge("left")?, right: edge("right")?, top: edge("top")?, bottom: edge("bottom")? })
    });
    let confidence = target.and_then(|t| t.get("confidence")).and_then(Value::as_f64);
    Ok((found, found_probability, rect.filter(Rect::valid), confidence))
}

/// Pergunta ao Jev olhando a foto. Bloqueante: chamar de `spawn_blocking`.
pub fn pick(db: &DbConnection, query: &VisualQuery) -> VisualReply {
    let settings = match db.lock().ok().and_then(|conn| config::load(&conn).ok()) {
        Some(settings) => settings,
        None => return VisualReply::without("error", "Não consegui ler os ajustes de Decisões."),
    };
    if !settings.active() || !settings.allows(POINT_BROWSE_VISION) || !settings.allows(super::points::POINT_BROWSE) {
        return VisualReply::without("off", "A reserva visual está desligada: ligue em Ajustes → Decisões (Navegador do canvas: reserva visual).");
    }
    // Imagens e `box` são do Jev 1.14: nenhum outro provedor entende.
    if settings.provider != ProviderKind::Jev {
        return VisualReply::without("off", "A reserva visual só funciona com o Jev.");
    }
    // O objetivo e o histórico saem como texto: o detector de segredos olha pelo menos estes.
    if memory_secret("", &query.goal, None) || memory_secret("", &query.recent, None) {
        return VisualReply::without("secret", "O objetivo parece conter um segredo: não enviei nada ao provedor.");
    }
    let png = match read_capture(&query.image_path) {
        Ok(png) => png,
        Err(reason) => return VisualReply::without("error", reason),
    };
    let api_key = config::load_key();
    pick_with(db, &settings, api_key.as_deref(), query, &png)
}

/// Só uma captura que o app salvou, e só um PNG de tamanho razoável. Quem pede a leitura é o frontend: não se confia no caminho.
fn read_capture(path: &str) -> Result<Vec<u8>, String> {
    let dir = crate::preview::capture::capture_dir();
    let wanted = Path::new(path).canonicalize().map_err(|_| "A foto da página não está mais no disco.".to_string())?;
    let allowed = dir.canonicalize().map_err(|_| "Não achei a pasta das capturas.".to_string())?;
    if !wanted.starts_with(&allowed) {
        return Err("Só uso fotos que o próprio app tirou da página.".into());
    }
    let png = std::fs::read(&wanted).map_err(|e| e.to_string())?;
    if !png.starts_with(&[0x89, b'P', b'N', b'G']) || png.len() > MAX_IMAGE_BYTES {
        return Err("A foto da página não é um PNG de tamanho aceitável.".into());
    }
    let (width, height) = png_size(&png).ok_or("Não consegui ler o tamanho da foto.")?;
    let area = u64::from(width) * u64::from(height);
    if !(MIN_AREA..=MAX_AREA).contains(&area) {
        return Err(format!("A foto tem {width}×{height}: o Jev só aceita áreas entre {MIN_AREA} e {MAX_AREA} pixels."));
    }
    Ok(png)
}

/// Largura e altura de um PNG (o cabeçalho IHDR, logo depois da assinatura). Pura.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[12..16] != b"IHDR" {
        return None;
    }
    Some((u32::from_be_bytes(png[16..20].try_into().ok()?), u32::from_be_bytes(png[20..24].try_into().ok()?)))
}

fn pick_with(db: &DbConnection, settings: &config::Settings, api_key: Option<&str>, query: &VisualQuery, png: &[u8]) -> VisualReply {
    let body = request_body(query);
    let boundary = format!("ags-{}", uuid::Uuid::new_v4().simple());
    let payload = multipart(&boundary, &body, png);
    let started = Instant::now();
    let sent = send(settings, api_key, &boundary, payload);
    let latency = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let reading = sent.and_then(|text| read_reply(&text));
    if let Ok(conn) = db.lock() {
        let _ = log::record(
            &conn,
            &LogRow {
                ts: now_ts(),
                point: POINT_BROWSE_VISION.into(),
                provider: settings.provider.as_str().into(),
                model: VISION_MODEL.into(),
                // Sem o texto do objetivo: o log guarda só quem consultou e como foi.
                state_hash: super::protocol::state_hash(&query.goal),
                heuristic: "existe=nenhum".into(),
                provider_decision: reading.as_ref().ok().map(|(found, _, _, _)| format!("existe={}", if *found { "yes" } else { "no" })),
                probability: reading.as_ref().ok().and_then(|(_, p, _, _)| *p),
                confidence: reading.as_ref().ok().and_then(|(_, _, _, c)| *c),
                latency_ms: Some(i64::try_from(latency).unwrap_or(i64::MAX)),
                error: reading.as_ref().err().map(|e| truncate_chars(e, 300)),
                input_tokens: None,
                output_tokens: None,
            },
        );
    }
    match reading {
        Ok((found, found_probability, rect, confidence)) => VisualReply {
            status: "ok",
            found: Some(found),
            found_probability,
            center: rect.map(|r| r.center()),
            rect,
            confidence,
            reason: None,
            latency_ms: Some(latency),
        },
        Err(reason) => VisualReply::without("error", reason),
    }
}

fn send(settings: &config::Settings, api_key: Option<&str>, boundary: &str, payload: Vec<u8>) -> Result<String, String> {
    use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
    let client = http::client().map_err(|e| e.code())?;
    let mut call = client
        .post(http::endpoint(&settings.base_url))
        // Duas perguntas e uma imagem: mais que os 800 ms do texto, e ainda assim curto.
        .timeout(std::time::Duration::from_millis(settings.timeout_ms.max(8_000)))
        .header(CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
        .header(IMAGES_HEADER, "true")
        .body(payload);
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        call = call.header(AUTHORIZATION, format!("Bearer {key}"));
    }
    let response = call.send().map_err(|e| http::map_transport(e, api_key).code())?;
    let status = response.status();
    let text = response.text().map_err(|e| http::map_transport(e, api_key).code())?;
    let text = super::shadow::redact(&text, api_key);
    match status.as_u16() {
        200 => Ok(text),
        401 => Err("O Jev recusou a chave (401).".into()),
        code => {
            let detail = super::protocol::client_error_message(&text);
            Err(if detail.is_empty() { format!("O Jev respondeu HTTP {code}.") } else { format!("O Jev respondeu HTTP {code}: {detail}") })
        }
    }
}

#[tauri::command]
pub async fn decision_pick_visual(db: tauri::State<'_, DbConnection>, query: VisualQuery) -> Result<VisualReply, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pick(&db, &query))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod test {
    use super::*;

    fn query() -> VisualQuery {
        VisualQuery { goal: "abrir o carrinho".into(), recent: "1. clicou botão Add to cart".into(), image_path: "x.png".into() }
    }

    #[test]
    fn o_pedido_liga_a_foto_ao_estado_e_leva_as_duas_perguntas() {
        let body = request_body(&query());
        assert_eq!(body["model"], "jev-preview");
        assert_eq!(body["state"]["photo"], "screenshot-1");
        assert_eq!(body["assets"]["screenshot-1"], json!({ "type": "image", "part": "screenshot" }));
        assert_eq!(body["questions"]["alvo"]["type"], "box");
        assert_eq!(body["questions"]["existe"]["type"], "choice");
        assert!(body["questions"]["alvo"]["instructions"].as_str().unwrap().contains("`photo`"));
        assert!(body["questions"]["existe"]["instructions"].as_str().unwrap().contains("abrir o carrinho"));
    }

    #[test]
    fn o_multipart_leva_o_json_e_a_foto_com_as_bordas_certas() {
        let png = [0x89, b'P', b'N', b'G', 1, 2, 3];
        let body = multipart("B", &json!({ "a": 1 }), &png);
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--B\r\nContent-Disposition: form-data; name=\"request\""));
        assert!(text.contains("name=\"screenshot\"; filename=\"screenshot.png\""));
        assert!(text.ends_with("\r\n--B--\r\n"));
        assert!(body.windows(png.len()).any(|w| w == png));
    }

    #[test]
    fn le_a_resposta_com_a_caixa_e_a_existencia() {
        let text = r#"{"model":"jev-1.14.0","answers":{
            "existe":{"type":"choice","choice":"yes","probabilities":{"yes":0.93,"no":0.07},"confidence":0.9},
            "alvo":{"type":"box","box":{"top":0.2,"bottom":0.4,"left":0.5,"right":0.7},"confidence":0.88}}}"#;
        let (found, p, rect, confidence) = read_reply(text).unwrap();
        assert!(found);
        assert_eq!(p, Some(0.93));
        let rect = rect.unwrap();
        assert!((rect.center().0 - 0.6).abs() < 1e-9 && (rect.center().1 - 0.3).abs() < 1e-9);
        assert_eq!(confidence, Some(0.88));
    }

    #[test]
    fn caixa_sem_area_ou_fora_da_imagem_nao_vale() {
        let flat = r#"{"answers":{"existe":{"choice":"yes","probabilities":{"yes":1}},"alvo":{"box":{"top":0.2,"bottom":0.2,"left":0.5,"right":0.7},"confidence":0.9}}}"#;
        assert!(read_reply(flat).unwrap().2.is_none());
        let outside = r#"{"answers":{"existe":{"choice":"yes","probabilities":{"yes":1}},"alvo":{"box":{"top":0.2,"bottom":1.4,"left":0.5,"right":0.7},"confidence":0.9}}}"#;
        assert!(read_reply(outside).unwrap().2.is_none());
    }

    #[test]
    fn resposta_estranha_e_erro() {
        assert!(read_reply("não é json").is_err());
        assert!(read_reply(r#"{"answers":{}}"#).is_err());
        assert!(read_reply(r#"{"answers":{"existe":{"choice":"talvez"}}}"#).is_err());
    }

    #[test]
    fn le_o_tamanho_de_um_png() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&485u32.to_be_bytes());
        png.extend_from_slice(&258u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((485, 258)));
        assert_eq!(png_size(&png[..10]), None);
    }

    #[test]
    fn so_se_le_uma_captura_do_proprio_app() {
        assert!(read_capture("C:/Windows/win.ini").is_err());
        assert!(read_capture("nao-existe.png").is_err());
    }

    /// SONDA REAL (gasta uma chamada paga por caso, com a chave do cofre): `cargo test --lib sonda_real -- --ignored --nocapture`.
    /// Usa a foto fictícia `teste-visual-fake.png` da pasta das capturas: uma barra com dois ícones sem nome (perfil e
    /// carrinho), uma busca e três botões. Mede se o centro da caixa cai em cima do alvo certo e quanto leva.
    #[test]
    #[ignore]
    fn sonda_real_do_jev_com_a_foto_de_teste() {
        let path = crate::preview::capture::capture_dir().join("teste-visual-fake.png");
        let png = read_capture(path.to_str().unwrap()).expect("rode o script que gera a foto de teste antes");
        let key = config::load_key().expect("sem chave do Jev no cofre");
        let settings = config::Settings { provider: ProviderKind::Jev, base_url: "https://api.typesafe.ai".into(), timeout_ms: 8000, ..Default::default() };
        // objetivo, a região (x0, x1, y0, y1) em que o centro tem que cair, ou None quando não há nada a tocar
        let cases: [(&str, Option<(f64, f64, f64, f64)>); 5] = [
            ("open the shopping cart", Some((0.86, 0.95, 0.03, 0.15))),
            ("go to my profile page", Some((0.79, 0.86, 0.03, 0.15))),
            ("create a new account", Some((0.30, 0.46, 0.33, 0.42))),
            ("log in", Some((0.10, 0.26, 0.33, 0.42))),
            ("unsubscribe from the newsletter", None),
        ];
        for (goal, region) in cases {
            let query = VisualQuery { goal: goal.into(), recent: String::new(), image_path: path.to_string_lossy().into_owned() };
            let body = request_body(&query);
            let boundary = "ags-sonda";
            let started = Instant::now();
            let text = send(&settings, Some(&key), boundary, multipart(boundary, &body, &png)).expect("a chamada falhou");
            let ms = started.elapsed().as_millis();
            let (found, p, rect, confidence) = read_reply(&text).expect("resposta ilegível");
            let center = rect.map(|r| r.center());
            let ok = match (found, region, center) {
                (true, Some((x0, x1, y0, y1)), Some((x, y))) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
                (false, None, _) => true,
                _ => false,
            };
            println!("{} | {goal:<34} existe={found} p={p:?} centro={center:?} conf={confidence:?} {ms} ms", if ok { "ACERTOU" } else { "ERROU  " });
        }
    }

    /// SONDA REAL das dimensões (uma chamada paga por tamanho): quais tamanhos de foto o Jev aceita. Usa os `dim-*.png`
    /// da pasta das capturas. `cargo test --lib sonda_dimensoes -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn sonda_dimensoes_aceitas_pelo_jev() {
        let dir = crate::preview::capture::capture_dir();
        let key = config::load_key().expect("sem chave do Jev no cofre");
        let settings = config::Settings { provider: ProviderKind::Jev, base_url: "https://api.typesafe.ai".into(), timeout_ms: 8000, ..Default::default() };
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("dim-"))).collect();
        files.sort();
        for path in files {
            let png = std::fs::read(&path).unwrap();
            let query = VisualQuery { goal: "open the shopping cart".into(), recent: String::new(), image_path: path.to_string_lossy().into_owned() };
            let body = request_body(&query);
            let started = Instant::now();
            let outcome = send(&settings, Some(&key), "ags-dim", multipart("ags-dim", &body, &png)).and_then(|t| read_reply(&t));
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            match outcome {
                Ok((found, p, rect, conf)) => println!("OK   {name:<20} existe={found} p={p:?} centro={:?} conf={conf:?} {} ms", rect.map(|r| r.center()), started.elapsed().as_millis()),
                Err(e) => println!("FALHA {name:<19} {e}"),
            }
        }
    }
}
