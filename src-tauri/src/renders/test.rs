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

/// Um PNG mínimo: a assinatura de 8 bytes e um pouco de conteúdo. Basta para o reconhecimento por bytes.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nconteudo";
const JPEG: &[u8] = b"\xFF\xD8\xFF\xE0conteudo";

/// Grava `bytes` em `nome` dentro de `pasta` (criada se preciso) e devolve o caminho.
fn arquivo_em(pasta: &Scratch, nome: &str, bytes: &[u8]) -> PathBuf {
    std::fs::create_dir_all(&pasta.0).unwrap();
    let path = pasta.0.join(nome);
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn embute_a_imagem_local_do_projeto_na_pagina_publicada() {
    let paginas = Scratch::new();
    let projeto = Scratch::new();
    let grafico = arquivo_em(&projeto, "grafico.png", PNG);
    let html = format!(r#"<!doctype html><img src="{}">"#, grafico.display());
    let page = publish_in(&paginas.0, TAB_A, &projeto.0.display().to_string(), "Gráfico", &html, 1).unwrap();
    let salvo = read_html_in(&paginas.0, &page.id).unwrap();
    // A assinatura do PNG em base64 (`\x89PNG\r\n\x1a\n` vira `iVBORw0K`).
    assert!(salvo.contains("data:image/png;base64,iVBORw0K"), "{salvo}");
    assert!(!salvo.contains(&grafico.display().to_string()), "o caminho do arquivo não sai na página");
    assert_eq!(page.bytes, salvo.len() as u64, "o tamanho guardado é o da página já com a imagem");
}

#[test]
fn recusa_imagem_de_fora_da_pasta_do_projeto_e_nao_publica_nada() {
    let paginas = Scratch::new();
    let projeto = Scratch::new();
    let fora = Scratch::new();
    std::fs::create_dir_all(&projeto.0).unwrap();
    let segredo = arquivo_em(&fora, "segredo.png", PNG);
    let html = format!(r#"<img src="{}">"#, segredo.display());
    let erro = publish_in(&paginas.0, TAB_A, &projeto.0.display().to_string(), "", &html, 1).unwrap_err();
    assert!(erro.contains("fora da pasta do projeto"), "{erro}");
    assert!(list_in(&paginas.0, None).unwrap().is_empty(), "uma imagem recusada não deixa página pela metade");
}

#[cfg(unix)]
#[test]
fn recusa_link_simbolico_que_sai_da_pasta_do_projeto() {
    let paginas = Scratch::new();
    let projeto = Scratch::new();
    let fora = Scratch::new();
    let segredo = arquivo_em(&fora, "segredo.png", PNG);
    std::fs::create_dir_all(&projeto.0).unwrap();
    let atalho = projeto.0.join("atalho.png");
    std::os::unix::fs::symlink(&segredo, &atalho).unwrap();
    let html = format!(r#"<img src="{}">"#, atalho.display());
    let erro = publish_in(&paginas.0, TAB_A, &projeto.0.display().to_string(), "", &html, 1).unwrap_err();
    assert!(erro.contains("fora da pasta do projeto"), "{erro}");
}

#[test]
fn recusa_arquivo_que_so_tem_nome_de_imagem_e_nao_repete_o_conteudo() {
    let paginas = Scratch::new();
    let projeto = Scratch::new();
    let disfarcado = arquivo_em(&projeto, "dados.png", b"TOKEN=abc123\n");
    let html = format!(r#"<img src="{}">"#, disfarcado.display());
    let erro = publish_in(&paginas.0, TAB_A, &projeto.0.display().to_string(), "", &html, 1).unwrap_err();
    assert!(erro.contains("não é uma imagem"), "{erro}");
    assert!(!erro.contains("abc123"), "a mensagem não repete o conteúdo do arquivo");
}

#[test]
fn sem_pasta_de_projeto_nenhuma_imagem_local_entra() {
    let paginas = Scratch::new();
    let projeto = Scratch::new();
    let grafico = arquivo_em(&projeto, "grafico.png", PNG);
    let html = format!(r#"<img src="{}">"#, grafico.display());
    let erro = publish_in(&paginas.0, TAB_A, "", "", &html, 1).unwrap_err();
    assert!(erro.contains("pasta do projeto"), "{erro}");
}

#[test]
fn caminhos_relativos_e_enderecos_remotos_ficam_como_estao() {
    let paginas = Scratch::new();
    let html = r#"<img src="logo.png"><img src="https://exemplo.com/a.png"><img src="//cdn.exemplo.com/b.png">"#;
    let page = publish_in(&paginas.0, TAB_A, "", "", html, 1).unwrap();
    assert_eq!(read_html_in(&paginas.0, &page.id).unwrap(), html);
}

#[test]
fn url_de_css_com_imagem_local_tambem_embute() {
    let paginas = Scratch::new();
    let projeto = Scratch::new();
    let foto = arquivo_em(&projeto, "foto.jpg", JPEG);
    let html = format!(r#"<div style="background:url({})"></div>"#, foto.display());
    let page = publish_in(&paginas.0, TAB_A, &projeto.0.display().to_string(), "", &html, 1).unwrap();
    let salvo = read_html_in(&paginas.0, &page.id).unwrap();
    assert!(salvo.contains("url(data:image/jpeg;base64,"), "{salvo}");
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

#[test]
fn acha_so_caminhos_absolutos_de_imagem_nos_quatro_lugares() {
    let html = r#"<img src="/a/b.png"><img src='C:\fotos\c.JPG'><img src="d.png"><img src="https://x.com/e.png"><img src="//f/g.png"><img src="/a/h.txt"><p style="background: url(/i/j.webp)"><code>`/k/l.gif`</code>"#;
    let achados: Vec<String> = super::images::find_local_images(html).into_iter().map(|a| a.caminho).collect();
    assert_eq!(achados, ["/a/b.png", r"C:\fotos\c.JPG", "/i/j.webp", "/k/l.gif"]);
}

#[test]
fn reconhece_imagem_pelos_bytes_e_nao_pelo_nome() {
    assert_eq!(super::images::tipo_de_imagem(PNG), Some("image/png"));
    assert_eq!(super::images::tipo_de_imagem(JPEG), Some("image/jpeg"));
    assert_eq!(super::images::tipo_de_imagem(b"GIF89a\x01\x00"), Some("image/gif"));
    assert_eq!(super::images::tipo_de_imagem(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
    assert_eq!(super::images::tipo_de_imagem(b"\x00\x00\x00\x18ftypavif\x00\x00"), Some("image/avif"));
    assert_eq!(
        super::images::tipo_de_imagem(br#"<?xml version="1.0"?>
<!-- um grafico -->
<svg xmlns="http://www.w3.org/2000/svg"></svg>"#),
        Some("image/svg+xml")
    );
    assert_eq!(super::images::tipo_de_imagem(b"<!doctype html><html></html>"), None, "uma página não vira imagem");
    assert_eq!(super::images::tipo_de_imagem(b"TOKEN=abc"), None);
}

#[test]
fn caminho_de_unidade_do_windows_tira_o_escape_de_js() {
    assert_eq!(super::images::caminho_de_arquivo(r"C:\\Users\\ana\\a.png"), PathBuf::from(r"C:\Users\ana\a.png"));
}

#[test]
fn imagem_acima_do_limite_e_recusada_e_a_pagina_com_imagens_tambem_tem_teto() {
    let projeto = Scratch::new();
    let grande = arquivo_em(&projeto, "grande.png", PNG);
    let html = format!(r#"<img src="{}">"#, grande.display());
    let apertado = super::images::Limits { image: 10, page: 1_000 };
    let erro = super::images::embed(&html, Some(&projeto.0), &[], apertado).unwrap_err();
    assert!(erro.contains("maior que"), "{erro}");
    let pagina_pequena = super::images::Limits { image: 100, page: 40 };
    let erro = super::images::embed(&html, Some(&projeto.0), &[], pagina_pequena).unwrap_err();
    assert!(erro.contains("passa de"), "{erro}");
}

#[test]
fn nao_le_imagem_da_pasta_de_dados_da_ade_mesmo_dentro_do_projeto() {
    let projeto = Scratch::new();
    let dados = projeto.0.join("dados");
    std::fs::create_dir_all(&dados).unwrap();
    let chave = dados.join("chave.png");
    std::fs::write(&chave, PNG).unwrap();
    let html = format!(r#"<img src="{}">"#, chave.display());
    let erro = super::images::embed(&html, Some(&projeto.0), &[dados.clone()], super::images::Limits::PADRAO).unwrap_err();
    assert!(erro.contains("dentro da pasta de dados da ADE"), "{erro}");
}
