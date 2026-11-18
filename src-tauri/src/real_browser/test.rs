//! Testes da superfície nativa do navegador (o Portal): o contrato do `Place` que chega do front e a lógica pura
//! que decide o que mudou, o que a máscara desenha e quando a vista é escondida.

use super::surface::{diff_place, effective_zoom, empty_clip_visibility, keeps_pumping, open_step, outline, rounded_parts, visibility_change, ClipState, CreationState, OpenStep, PathStep, PlaceChanges, PlaceState};
use super::{Place, Rect};
use serde_json::json;

#[test]
fn place_le_os_campos_que_o_front_manda() {
    // O front manda camelCase (`cornerRadius`, `clickToExpand`, `visibleRect`). Sem `rename_all`, esses campos
    // viravam o valor padrão em silêncio: o raio dos cantos do PiP nunca chegava ao Rust.
    let place: Place = serde_json::from_value(json!({
        "rect": { "x": 10.0, "y": 20.0, "width": 300.0, "height": 200.0 },
        "zoom": 0.8,
        "visible": true,
        "visibleRect": { "x": 0.0, "y": 0.0, "width": 300.0, "height": 200.0 },
        "holes": [],
        "clickToExpand": true,
        "cornerRadius": 16.0
    }))
    .expect("o front manda camelCase");

    assert_eq!(place.corner_radius, 16.0);
    assert!(place.click_to_expand);
    assert!(place.visible);
    assert_eq!(place.visible_rect, Some(Rect { x: 0.0, y: 0.0, width: 300.0, height: 200.0 }));
}

#[test]
fn path_da_mascara_tem_cantos_arredondados_com_partes() {
    // Duas partes lado a lado: a da esquerda toca os cantos da esquerda, a da direita os da direita.
    let parts = rounded_parts(200, 120, &[[0, 0, 100, 120], [100, 0, 200, 120]], 16.0);

    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].corners, [true, false, false, true]);
    assert_eq!(parts[1].corners, [false, true, true, false]);

    // O contorno tem um arco por canto externo: quatro no total, dois por parte, e nenhum no corte do meio.
    let arcs: Vec<[f64; 2]> = parts
        .iter()
        .flat_map(outline)
        .filter_map(|step| match step {
            PathStep::Arc { corner, .. } => Some(corner),
            _ => None,
        })
        .collect();
    assert_eq!(arcs, vec![[0.0, 120.0], [0.0, 0.0], [200.0, 0.0], [200.0, 120.0]]);
}

#[test]
fn place_igual_nao_reaplica() {
    let place = PlaceState { frame: [10, 20, 320, 240], parts: vec![[0, 0, 320, 240]], radius: 16.0, zoom: 0.8 };

    // Igual ao último aplicado: nada a reaplicar (nem frame, nem máscara, nem zoom, nem repintura do CEF).
    assert_eq!(diff_place(Some(&place), &place), PlaceChanges::default());

    // Só o raio mudou: a máscara muda, o resto não.
    let mut rounded = place.clone();
    rounded.radius = 24.0;
    assert_eq!(diff_place(Some(&place), &rounded), PlaceChanges { mask: true, ..PlaceChanges::default() });

    // Só a posição mudou: move a vista, sem máscara nem repintura.
    let mut moved = place.clone();
    moved.frame[0] = 99;
    assert_eq!(diff_place(Some(&place), &moved), PlaceChanges { frame: true, ..PlaceChanges::default() });

    // Sem último aplicado, tudo é aplicado.
    assert_eq!(diff_place(None, &place), PlaceChanges { frame: true, mask: true, zoom: true, resized: true });
}

#[test]
fn recorte_vazio_transitorio_nao_esconde() {
    let mut hidden = false;
    let mut empty_count = 0;

    // Um quadro sem recorte (uma transição) não esconde a vista.
    assert!(!empty_clip_visibility(&mut empty_count, &mut hidden, true, false));
    // Dois seguidos sem recorte escondem.
    assert!(empty_clip_visibility(&mut empty_count, &mut hidden, true, false));
    // Voltar a ter recorte mostra a vista de novo.
    assert!(!empty_clip_visibility(&mut empty_count, &mut hidden, false, false));
    // O `visible: false` explícito (a desmontagem) esconde na hora, mesmo com recorte.
    assert!(empty_clip_visibility(&mut empty_count, &mut hidden, false, true));
}

#[test]
fn zoom_zero_mantem_o_ultimo_zoom_valido() {
    // A vista sem largura manda zoom 0: não é 100%, é "sem zoom novo".
    assert_eq!(effective_zoom(0.0, Some(0.8)), 0.8);
    assert_eq!(effective_zoom(0.0, None), 1.0);
    assert_eq!(effective_zoom(0.5, Some(0.8)), 0.5);
}

#[test]
fn bomba_do_cef_so_roda_com_navegador_aberto() {
    // Sem nenhum navegador aberto nem em criação, a bomba não se reagenda; com um, segue.
    assert!(!keeps_pumping(0, 0));
    assert!(keeps_pumping(1, 0));
    assert!(keeps_pumping(3, 0));
}

#[test]
fn bomba_do_cef_roda_enquanto_o_primeiro_navegador_e_criado() {
    // O primeiro navegador só termina de nascer com a bomba rodando.
    assert!(keeps_pumping(0, 1));
}

#[test]
fn timeout_limpa_registro() {
    // Uma criação pendente que estoura o prazo é cancelada: o callback tardio dela não é aceito.
    let mut creation = CreationState::new(7);
    assert!(creation.cancel_if_pending(7));
    assert!(!creation.accepts_callback(7));
    assert!(!creation.accepts_callback(8));
}

#[test]
fn timeout_nao_desfaz_criacao_ja_pronta() {
    let mut creation = CreationState::new(3);
    assert!(creation.mark_ready(3));
    assert!(!creation.cancel_if_pending(3));
    assert!(creation.accepts_callback(3));
}

#[test]
fn visibilidade_so_muda_na_transicao() {
    // A mesma regra vale no macOS (setHidden) e no Windows (ShowWindow): só a transição pede uma mudança na vista.
    let mut state = ClipState::default();
    assert_eq!(visibility_change(&mut state, false, false), None);
    assert_eq!(visibility_change(&mut state, true, false), None, "um quadro vazio não esconde");
    assert_eq!(visibility_change(&mut state, true, false), Some(true), "o segundo quadro vazio esconde");
    assert_eq!(visibility_change(&mut state, true, false), None, "já escondida: nada a fazer");
    assert_eq!(visibility_change(&mut state, false, false), Some(false), "volta a ter recorte: mostra");
    assert_eq!(visibility_change(&mut state, false, true), Some(true), "desmontagem: esconde na hora");
    assert_eq!(visibility_change(&mut state, false, true), None);
}

#[test]
fn abrir_portal_em_preparo_aguarda_a_criacao() {
    // Sem Portal, cria; com um Portal pronto, atende; com um Portal ainda preparando, espera a mesma criação
    // (antes, o segundo pedido recebia erro e a página não abria).
    assert_eq!(open_step(false, false), OpenStep::Create);
    assert_eq!(open_step(true, true), OpenStep::Attached);
    assert_eq!(open_step(true, false), OpenStep::Join);
}
