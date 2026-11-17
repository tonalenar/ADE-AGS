//! Testes da superfície nativa do navegador (o Portal): o contrato do `Place` que chega do front e a lógica pura
//! que decide o que mudou, o que a máscara desenha e quando a vista é escondida.

use super::surface::{diff_place, outline, rounded_parts, PathStep, PlaceChanges, PlaceState};
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
