//! Precio de lista (API) de los modelos de Claude, para ESTIMAR cuánto costaron los tokens
//! medidos de una misión y cuánto ahorró el caché.
//!
//! Es una estimación y se muestra como tal: una suscripción no cobra por token. Los tokens
//! son medidos; el precio es de tabla. Un modelo que la tabla no conoce NO se valora (no se
//! inventa): queda fuera del costo y se avisa.
//!
//! Encima de la tabla, la persona puede fijar el precio de un modelo (Configuración → Uso y precios). Ese
//! precio gana a la tabla. Se guarda en la carpeta de datos, en un JSON aparte del banco: es una preferencia
//! de estimación, no dato de conversación.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

/// El archivo de precios definidos por la persona, en la carpeta de datos.
const OVERRIDES_FILE: &str = "usage-prices.json";
const MAX_MODEL_CHARS: usize = 128;
const MAX_USD_PER_MILLION: f64 = 10_000.0;

/// USD por millón de tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Price {
    pub input: f64,
    pub output: f64,
}

/// Escribir caché cuesta 1,25× la entrada; leerlo, 0,1×.
const CACHE_WRITE_FACTOR: f64 = 1.25;
const CACHE_READ_FACTOR: f64 = 0.10;

/// Un precio que la persona fijó para un modelo (USD por millón de tokens).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceOverride {
    pub model: String,
    pub input: f64,
    pub output: f64,
}

/// Una fila de la tabla de lista, para mostrarla al lado de los precios definidos.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPrice {
    pub family: &'static str,
    pub input: f64,
    pub output: f64,
}

/// La tabla de lista que `builtin_price_for` aplica (las mismas cifras que abajo).
pub(crate) const LIST_PRICES: &[ListPrice] = &[
    ListPrice { family: "Claude Opus 4.5 y posteriores", input: 5.0, output: 25.0 },
    ListPrice { family: "Claude Opus 4 y 4.1", input: 15.0, output: 75.0 },
    ListPrice { family: "Claude Sonnet", input: 3.0, output: 15.0 },
    ListPrice { family: "Claude Haiku 4.5", input: 1.0, output: 5.0 },
    ListPrice { family: "Claude Haiku 3.5", input: 0.8, output: 4.0 },
];

/// Lo que la pantalla lee: los precios definidos (ordenados por modelo) y la tabla de lista.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricesView {
    pub overrides: Vec<PriceOverride>,
    pub list: Vec<ListPrice>,
}

/// Los precios definidos por la persona, en memoria. Se carga la primera vez desde el archivo.
static OVERRIDES: OnceLock<RwLock<BTreeMap<String, Price>>> = OnceLock::new();

fn store() -> &'static RwLock<BTreeMap<String, Price>> {
    OVERRIDES.get_or_init(|| RwLock::new(initial_overrides()))
}

#[cfg(not(test))]
fn initial_overrides() -> BTreeMap<String, Price> {
    crate::util::datadir::ags_home().map(|home| read_overrides(&home.join(OVERRIDES_FILE))).unwrap_or_default()
}

/// En las pruebas el mapa empieza vacío: nunca lee la carpeta de datos real.
#[cfg(test)]
fn initial_overrides() -> BTreeMap<String, Price> {
    BTreeMap::new()
}

/// Valida un precio que llega de la pantalla. El modelo se guarda en minúsculas, sin espacios en los bordes.
pub(crate) fn validate(model: &str, input: f64, output: f64) -> Result<(String, Price), String> {
    let key = model.trim().to_ascii_lowercase();
    if key.is_empty() || key.chars().count() > MAX_MODEL_CHARS || key.chars().any(char::is_control) {
        return Err("Informe o identificador do modelo (até 128 caracteres, sem quebra de linha).".into());
    }
    let valid = |v: f64| v.is_finite() && (0.0..=MAX_USD_PER_MILLION).contains(&v);
    if !valid(input) || !valid(output) {
        return Err("O preço precisa estar entre 0 e 10 000 USD por milhão de tokens.".into());
    }
    Ok((key, Price { input, output }))
}

/// Lee el archivo de precios. Lo que no vale (modelo vacío, precio negativo o no finito) sale; el resto queda.
pub(crate) fn read_overrides(path: &Path) -> BTreeMap<String, Price> {
    let Ok(raw) = std::fs::read_to_string(path) else { return BTreeMap::new() };
    let Ok(list) = serde_json::from_str::<Vec<PriceOverride>>(&raw) else { return BTreeMap::new() };
    list.into_iter()
        .filter_map(|o| validate(&o.model, o.input, o.output).ok())
        .collect()
}

/// Escribe la lista entera: un archivo temporal y después el cambio de nombre, para no dejar un JSON a medias.
pub(crate) fn save_overrides(path: &Path, map: &BTreeMap<String, Price>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let list: Vec<PriceOverride> = map
        .iter()
        .map(|(model, p)| PriceOverride { model: model.clone(), input: p.input, output: p.output })
        .collect();
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// El precio de un modelo: el que la persona definió (por identificador exacto), y si no hay, la tabla.
pub(crate) fn resolve(overrides: &BTreeMap<String, Price>, model: &str) -> Option<Price> {
    overrides.get(&model.trim().to_ascii_lowercase()).copied().or_else(|| builtin_price_for(model))
}

/// El precio que la estimación usa para un modelo: el definido por la persona, o el de la tabla de lista.
pub(crate) fn price_for(model: &str) -> Option<Price> {
    let overrides = store().read().ok()?;
    resolve(&overrides, model)
}

fn persist(map: &BTreeMap<String, Price>) -> Result<(), String> {
    let home = crate::util::datadir::ags_home().ok_or("Pasta de dados indisponível")?;
    save_overrides(&home.join(OVERRIDES_FILE), map)
}

fn view() -> PricesView {
    let overrides = store()
        .read()
        .map(|map| {
            map.iter()
                .map(|(model, p)| PriceOverride { model: model.clone(), input: p.input, output: p.output })
                .collect()
        })
        .unwrap_or_default();
    PricesView { overrides, list: LIST_PRICES.to_vec() }
}

/// Os preços definidos e a tabela de lista, para a página de Uso e preços.
#[tauri::command]
pub fn usage_prices_get() -> Result<PricesView, String> {
    Ok(view())
}

/// Define o preço de um modelo. Grava no arquivo antes de mudar na memória: se o disco falhar, a tela não mente.
#[tauri::command]
pub fn usage_price_set(model: String, input: f64, output: f64) -> Result<PricesView, String> {
    let (key, price) = validate(&model, input, output)?;
    let mut next = store().read().map_err(|_| "Os preços estão travados. Reabra o app.".to_string())?.clone();
    next.insert(key, price);
    persist(&next)?;
    *store().write().map_err(|_| "Os preços estão travados. Reabra o app.".to_string())? = next;
    Ok(view())
}

/// Volta um modelo à tabela de lista (tira o preço definido por ele).
#[tauri::command]
pub fn usage_price_clear(model: String) -> Result<PricesView, String> {
    let key = model.trim().to_ascii_lowercase();
    let mut next = store().read().map_err(|_| "Os preços estão travados. Reabra o app.".to_string())?.clone();
    next.remove(&key);
    persist(&next)?;
    *store().write().map_err(|_| "Os preços estão travados. Reabra o app.".to_string())? = next;
    Ok(view())
}

/// A tabela de lista (sem o que a pessoa definiu): cada família de modelo tem o seu preço.
fn builtin_price_for(model: &str) -> Option<Price> {
    let m = model.to_ascii_lowercase();
    if m.contains("synthetic") {
        return None;
    }
    let p = |input, output| Some(Price { input, output });
    if m.contains("opus") {
        // Opus 4 y 4.1 costaban 15/75; desde 4.5, 5/25.
        let legacy = m.contains("opus-4-1") || m.contains("opus-4-2025") || m.ends_with("opus-4") || m.contains("opus-4-0");
        return if legacy { p(15.0, 75.0) } else { p(5.0, 25.0) };
    }
    if m.contains("sonnet") {
        return p(3.0, 15.0);
    }
    if m.contains("haiku") {
        return if m.contains("3-5") { p(0.8, 4.0) } else { p(1.0, 5.0) };
    }
    None
}

/// Lo que el caché le ahorró al usuario frente a pagar esos tokens como entrada normal.
pub(crate) fn cache_saved_usd(price: Price, cache_read: u64) -> f64 {
    cache_read as f64 * price.input * (1.0 - CACHE_READ_FACTOR) / 1_000_000.0
}

/// Costo estimado de un registro de uso con el precio de lista.
pub(crate) fn cost_usd(price: Price, input: u64, output: u64, cache_write: u64, cache_read: u64) -> f64 {
    (input as f64 * price.input
        + output as f64 * price.output
        + cache_write as f64 * price.input * CACHE_WRITE_FACTOR
        + cache_read as f64 * price.input * CACHE_READ_FACTOR)
        / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precios_por_familia_y_modelos_desconocidos() {
        assert_eq!(price_for("claude-sonnet-4-5"), Some(Price { input: 3.0, output: 15.0 }));
        assert_eq!(price_for("claude-opus-4-1-20250805"), Some(Price { input: 15.0, output: 75.0 }));
        assert_eq!(price_for("claude-opus-4-5"), Some(Price { input: 5.0, output: 25.0 }));
        assert_eq!(price_for("claude-haiku-4-5-20251001"), Some(Price { input: 1.0, output: 5.0 }));
        assert_eq!(price_for("<synthetic>"), None);
        assert_eq!(price_for("gpt-6.1-sol"), None);
    }

    fn mapa(pares: &[(&str, f64, f64)]) -> BTreeMap<String, Price> {
        pares.iter().map(|(m, i, o)| ((*m).to_owned(), Price { input: *i, output: *o })).collect()
    }

    #[test]
    fn un_precio_definido_gana_a_la_tabla_y_sin_el_vuelve_la_tabla() {
        let definido = mapa(&[("claude-sonnet-4-5", 1.0, 2.0)]);
        assert_eq!(resolve(&definido, "Claude-Sonnet-4-5"), Some(Price { input: 1.0, output: 2.0 }));
        assert_eq!(resolve(&BTreeMap::new(), "claude-sonnet-4-5"), Some(Price { input: 3.0, output: 15.0 }));
        // Un modelo que la tabla no conoce y que la persona no tasó sigue sin precio.
        assert_eq!(resolve(&definido, "gpt-6.1-sol"), None);
    }

    #[test]
    fn valida_el_modelo_y_el_precio_antes_de_guardar() {
        assert_eq!(validate("  Claude-Opus-4-5 ", 5.0, 25.0), Ok(("claude-opus-4-5".into(), Price { input: 5.0, output: 25.0 })));
        assert!(validate("   ", 1.0, 1.0).is_err());
        assert!(validate(&"x".repeat(129), 1.0, 1.0).is_err());
        assert!(validate("a\nb", 1.0, 1.0).is_err());
        assert!(validate("m", -0.1, 1.0).is_err());
        assert!(validate("m", 1.0, f64::NAN).is_err());
        assert!(validate("m", 1.0, 10_000.5).is_err());
        assert!(validate("m", 0.0, 10_000.0).is_ok());
    }

    #[test]
    fn el_archivo_que_no_vale_se_descarta_y_el_resto_queda() {
        let dir = std::env::temp_dir().join(format!("ade-ags-precios-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(OVERRIDES_FILE);
        std::fs::write(
            &path,
            r#"[{"model":"Claude-Opus-4-5","input":5,"output":25},{"model":"","input":1,"output":1},{"model":"m","input":-1,"output":1}]"#,
        )
        .unwrap();
        let lidos = read_overrides(&path);
        assert_eq!(lidos.len(), 1);
        assert_eq!(lidos.get("claude-opus-4-5"), Some(&Price { input: 5.0, output: 25.0 }));
        std::fs::write(&path, "{ no es una lista").unwrap();
        assert!(read_overrides(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lo_que_se_guarda_se_lee_de_vuelta_igual() {
        let dir = std::env::temp_dir().join(format!("ade-ags-precios-ida-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join("sub").join(OVERRIDES_FILE);
        let original = mapa(&[("claude-haiku-4-5", 1.5, 6.0), ("claude-opus-4-5", 5.0, 25.0)]);
        save_overrides(&path, &original).expect("gravar");
        assert_eq!(read_overrides(&path), original);
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn la_tabla_de_lista_que_se_muestra_es_la_que_se_aplica() {
        assert_eq!(builtin_price_for("claude-opus-4-5"), Some(Price { input: 5.0, output: 25.0 }));
        assert_eq!(builtin_price_for("claude-opus-4-1"), Some(Price { input: 15.0, output: 75.0 }));
        assert_eq!(builtin_price_for("claude-sonnet-4-6"), Some(Price { input: 3.0, output: 15.0 }));
        assert_eq!(builtin_price_for("claude-haiku-4-5"), Some(Price { input: 1.0, output: 5.0 }));
        assert_eq!(builtin_price_for("claude-3-5-haiku"), Some(Price { input: 0.8, output: 4.0 }));
        assert_eq!(LIST_PRICES.len(), 5);
    }

    #[test]
    fn costo_y_ahorro_del_cache() {
        let sonnet = Price { input: 3.0, output: 15.0 };
        // 1 M de entrada = 3 USD; 1 M de salida = 15; 1 M escritura = 3,75; 1 M lectura = 0,30.
        let usd = cost_usd(sonnet, 1_000_000, 1_000_000, 1_000_000, 1_000_000);
        assert!((usd - (3.0 + 15.0 + 3.75 + 0.30)).abs() < 1e-9);
        // Leer 1 M de caché en vez de pagarlo como entrada ahorra 2,70.
        assert!((cache_saved_usd(sonnet, 1_000_000) - 2.70).abs() < 1e-9);
        assert_eq!(cache_saved_usd(sonnet, 0), 0.0);
    }
}
