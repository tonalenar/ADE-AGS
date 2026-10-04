//! Precio de lista (API) de los modelos de Claude, para ESTIMAR cuánto costaron los tokens
//! medidos de una misión y cuánto ahorró el caché.
//!
//! Es una estimación y se muestra como tal: una suscripción no cobra por token. Los tokens
//! son medidos; el precio es de tabla. Un modelo que la tabla no conoce NO se valora (no se
//! inventa): queda fuera del costo y se avisa.

/// USD por millón de tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Price {
    pub input: f64,
    pub output: f64,
}

/// Escribir caché cuesta 1,25× la entrada; leerlo, 0,1×.
const CACHE_WRITE_FACTOR: f64 = 1.25;
const CACHE_READ_FACTOR: f64 = 0.10;

pub(crate) fn price_for(model: &str) -> Option<Price> {
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
