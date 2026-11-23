use super::failure::{classify, parse_reset_at, FailureKind::*};

#[test]
fn cota_individual_esgotada_e_limite() {
    for text in [
        "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 117h6m21s.",
        "Individual quota reached",
        "Quota reached for this account",
        "Please upgrade your subscription to increase your limits.",
        "Usage limit reached. Resets in 3h",
        "Daily limit reached, resets in 2 hours 10 minutes",
        "Message limit reached. Resets at 18:00 UTC",
    ] {
        assert_eq!(classify(text), RateLimited, "{text}");
    }
}

#[test]
fn texto_parecido_com_cota_mas_sem_esgotar_nao_e_limite() {
    for text in [
        "quota reached the 10 file limit of the cache directory in src/lib.rs",
        "limit reached in the loop at main.rs:12",
        "the budget was reached; upgrade the subscription tests",
        "subscription renewal reminder",
    ] {
        assert_eq!(classify(text), Other, "{text}");
    }
}

#[test]
fn prazo_compacto_sem_espacos_e_lido() {
    let now = 1_000_000;
    let text = "Individual quota reached. Resets in 117h6m21s.";
    assert_eq!(parse_reset_at(text, now, 0), Some(now + 117 * 3600 + 6 * 60 + 21));
    assert_eq!(parse_reset_at("Resets in 2h30m", now, 0), Some(now + 9000));
    assert_eq!(parse_reset_at("Resets in 45s", now, 0), Some(now + 45));
    assert_eq!(parse_reset_at("Resets in 6d2h", now, 0), Some(now + 6 * 86_400 + 7200));
}
