use std::fs;

use super::attach::*;

fn dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("ags-attach-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn reconhece_imagem_arquivo_e_pasta_sem_ler_o_conteudo() {
    let d = dir();
    let img = d.join("captura.PNG");
    let doc = d.join("relatorio.pdf");
    fs::write(&img, [1u8, 2, 3]).unwrap();
    fs::write(&doc, b"pdf").unwrap();
    let i = inspect(img.to_str().unwrap());
    assert_eq!((i.kind, i.mime, i.size, i.error.is_none()), ("image", Some("image/png"), Some(3), true));
    let f = inspect(doc.to_str().unwrap());
    assert_eq!((f.kind, f.mime, f.size), ("file", None, Some(3)));
    let p = inspect(d.to_str().unwrap());
    assert_eq!((p.kind, p.size), ("folder", None));
}

#[test]
fn caminho_ruim_vira_aviso_e_nao_erro_da_chamada() {
    assert_eq!(inspect("/nao/existe/x.png").error.as_deref(), Some("arquivo não encontrado"));
    assert_eq!(inspect("relativo.png").error.as_deref(), Some("caminho não absoluto"));
}

#[test]
fn so_le_imagem_dentro_do_limite() {
    let d = dir();
    let ok = d.join("a.png");
    let txt = d.join("a.txt");
    let vazia = d.join("v.png");
    fs::write(&ok, [9u8; 10]).unwrap();
    fs::write(&txt, b"segredo").unwrap();
    fs::write(&vazia, []).unwrap();
    let data = read_preview(ok.to_str().unwrap()).unwrap();
    assert!(data.data_url.starts_with("data:image/png;base64,"));
    // um arquivo que não é imagem nunca é lido, nem se for pedido
    assert!(read_preview(txt.to_str().unwrap()).is_err());
    assert!(read_preview(vazia.to_str().unwrap()).is_err());
    assert!(read_preview(d.to_str().unwrap()).is_err());
}

#[test]
fn blocos_de_imagem_do_claude_respeitam_os_limites_e_nunca_derrubam_a_mensagem() {
    let d = dir();
    let boa = d.join("boa.jpg");
    let grande = d.join("grande.png");
    fs::write(&boa, [1u8; 100]).unwrap();
    fs::write(&grande, vec![0u8; (INLINE_IMAGE_MAX + 1) as usize]).unwrap();
    let paths = vec![boa.to_string_lossy().into_owned(), grande.to_string_lossy().into_owned(), "/nao/existe.png".to_string()];
    let (blocks, skipped) = image_blocks(&paths);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["source"]["media_type"], "image/jpeg");
    assert_eq!(blocks[0]["type"], "image");
    assert_eq!(skipped, vec![paths[1].clone(), paths[2].clone()]);
}

#[test]
fn passa_do_teto_de_imagens_em_linha_so_o_caminho_no_texto() {
    let d = dir();
    let paths: Vec<String> = (0..INLINE_IMAGES_PER_MESSAGE + 2).map(|i| {
        let p = d.join(format!("{i}.png"));
        fs::write(&p, [1u8]).unwrap();
        p.to_string_lossy().into_owned()
    }).collect();
    let (blocks, skipped) = image_blocks(&paths);
    assert_eq!(blocks.len(), INLINE_IMAGES_PER_MESSAGE);
    assert_eq!(skipped.len(), 2);
}
