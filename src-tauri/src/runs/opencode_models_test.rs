//! A descoberta de modelos do OpenCode: saídas reais do `opencode models` (v2.2.1), sem processo.

use super::roster::{self, ModelAvailability};

/// `opencode models` do 2.2.1: um id por linha, só dos provedores conectados.
const V2: &str = "anthropic/claude-opus-5\nanthropic/claude-haiku-5-5\nopencode/big-pickle\nopencode/beam-free\n";

#[test]
fn lista_simples_do_opencode_2_vira_modelos_agrupaveis_por_provedor() {
    let modelos = roster::parse_opencode_models(V2);
    let provedores: Vec<&str> = modelos.iter().map(|m| m.provider.as_str()).collect();
    assert_eq!(provedores, ["anthropic", "anthropic", "opencode", "opencode"]);
    assert_eq!(modelos[0].id, "anthropic/claude-opus-5");
    assert_eq!(modelos[0].toolcall, None, "sem --verbose não se inventa capacidade");
}

#[test]
fn linha_de_aviso_ou_vazia_nao_e_modelo() {
    let texto = "Warning: usando a/b como padrão\n\nanthropic/claude-opus-5\n  \n";
    let modelos = roster::parse_opencode_models(texto);
    assert_eq!(modelos.len(), 1);
    assert_eq!(modelos[0].id, "anthropic/claude-opus-5");
}

#[test]
fn nenhum_provedor_conectado_da_lista_vazia() {
    assert!(roster::parse_opencode_models("").is_empty());
    assert!(roster::opencode_roster_models(&[], None).is_empty());
}

#[test]
fn modelo_de_provedor_remoto_fica_com_disponibilidade_desconhecida() {
    let modelos = roster::parse_opencode_models(V2);
    let roster = roster::opencode_roster_models(&modelos, None);
    assert!(roster.iter().all(|m| m.availability == ModelAvailability::Unknown && !m.local));
}

#[test]
fn variants_do_opencode_viram_niveis_de_esforco_do_modelo() {
    let verbose = "anthropic/claude-sonnet-5-5\n{\n  \"name\": \"Sonnet 5.5\",\n  \"variants\": {\"high\": {}, \"low\": {}, \"medium\": {}, \"estranho\": {}}\n}\nopencode/big-pickle\n{\n  \"name\": \"Big Pickle\"\n}\n";
    let modelos = roster::parse_opencode_models(verbose);
    assert_eq!(modelos[0].variants, ["low", "medium", "high"], "só níveis conhecidos, na ordem do menor ao maior");
    assert!(modelos[1].variants.is_empty());
    let roster = roster::opencode_roster_models(&modelos, None);
    assert_eq!(roster[0].reasoning_levels.as_deref(), Some(["low".to_string(), "medium".to_string(), "high".to_string()].as_slice()));
    assert!(roster[1].reasoning_levels.is_none(), "sem variants não se inventa esforço");
}
