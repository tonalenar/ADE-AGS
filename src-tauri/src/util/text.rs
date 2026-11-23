//! Helpers pequenos de texto compartilhados pelo backend.

/// Aparando espaços das pontas, limita `text` a `max` caracteres sem partir caracteres UTF-8.
/// Quando trunca, inclui `…` dentro do limite (`max == 0` devolve vazio).
pub fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if max == 0 {
        return String::new();
    }
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod test {
    use super::clip;

    #[test]
    fn clip_respeita_limite_e_fronteira_utf8() {
        assert_eq!(clip("  olá  ", 10), "olá");
        assert_eq!(clip("ação rápida", 5), "ação…");
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abcd", 1), "…");
        assert_eq!(clip("abcd", 0), "");
    }
}
