use std::path::PathBuf;

use super::store::{clean_title, html_path, validate_html, MAX_HTML_BYTES, MAX_TITLE_CHARS};
use super::{delete_in, list_in, publish_in, read_html_in};

/// Uma pasta nova por teste, na temporária do sistema. Nunca `~/.ags`.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ade-renders-{}", uuid::Uuid::new_v4().simple()));
        Scratch(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const TAB_A: &str = "tab-a";
const TAB_B: &str = "tab-b";
const PAGE: &str = "<!doctype html><title>Gráfico</title><svg></svg>";

#[test]
fn publica_e_lista_a_pagina_mais_nova_primeiro() {
    let scratch = Scratch::new();
    let older = publish_in(&scratch.0, TAB_A, "/projeto", "Primeira", PAGE, 1_000).unwrap();
    let newer = publish_in(&scratch.0, TAB_A, "/projeto", "Segunda", PAGE, 2_000).unwrap();
    let pages = list_in(&scratch.0, None).unwrap();
    assert_eq!(pages.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), [newer.id.as_str(), older.id.as_str()]);
    assert_eq!(pages[0].owner, TAB_A);
    assert_eq!(pages[0].cwd, "/projeto");
    assert_eq!(pages[0].bytes, PAGE.len() as u64);
}

#[test]
fn a_lista_de_uma_aba_so_traz_as_paginas_dela() {
    let scratch = Scratch::new();
    publish_in(&scratch.0, TAB_A, "/projeto", "Da A", PAGE, 1).unwrap();
    publish_in(&scratch.0, TAB_B, "/projeto", "Da B", PAGE, 2).unwrap();
    let mine = list_in(&scratch.0, Some(TAB_A)).unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].title, "Da A");
}

#[test]
fn le_o_html_publicado_e_recusa_id_fora_do_formato_e_id_desconhecido() {
    let scratch = Scratch::new();
    let page = publish_in(&scratch.0, TAB_A, "", "Gráfico", PAGE, 1).unwrap();
    assert_eq!(read_html_in(&scratch.0, &page.id).unwrap(), PAGE);
    // Um id que tenta sair da pasta nunca chega ao disco.
    assert!(read_html_in(&scratch.0, "../index").unwrap_err().contains("inválido"));
    assert!(read_html_in(&scratch.0, "00000000-0000-0000-0000-000000000000").unwrap_err().contains("Não há página"));
}

#[test]
fn apagar_tira_o_arquivo_e_a_entrada_do_indice() {
    let scratch = Scratch::new();
    let page = publish_in(&scratch.0, TAB_A, "", "Some", PAGE, 1).unwrap();
    assert!(html_path(&scratch.0, &page.id).exists());
    delete_in(&scratch.0, &page.id).unwrap();
    assert!(!html_path(&scratch.0, &page.id).exists());
    assert!(list_in(&scratch.0, None).unwrap().is_empty());
    assert!(delete_in(&scratch.0, &page.id).is_err(), "apagar duas vezes é erro, não silêncio");
}

#[test]
fn recusa_html_vazio_e_acima_do_limite() {
    assert!(validate_html("   \n").unwrap_err().contains("vazia"));
    let grande = "a".repeat(MAX_HTML_BYTES + 1);
    assert!(validate_html(&grande).unwrap_err().contains("KiB"));
    assert!(validate_html(&"a".repeat(MAX_HTML_BYTES)).is_ok());
}

#[test]
fn o_titulo_fica_em_uma_linha_com_limite_e_padrao_quando_vazio() {
    assert_eq!(clean_title("  Vendas\n\n  do   mês "), "Vendas do mês");
    assert_eq!(clean_title("   "), "Página HTML");
    let longo: String = "é".repeat(MAX_TITLE_CHARS + 30);
    assert_eq!(clean_title(&longo).chars().count(), MAX_TITLE_CHARS);
}

#[test]
fn indice_ilegivel_da_erro_e_nao_e_sobrescrito() {
    let scratch = Scratch::new();
    std::fs::create_dir_all(&scratch.0).unwrap();
    let index = scratch.0.join("index.json");
    std::fs::write(&index, b"{ isso nao e json").unwrap();
    let erro = publish_in(&scratch.0, TAB_A, "", "Nova", PAGE, 1).unwrap_err();
    assert!(erro.contains("ilegível"), "{erro}");
    assert_eq!(std::fs::read(&index).unwrap(), b"{ isso nao e json", "o arquivo original fica intacto");
}
