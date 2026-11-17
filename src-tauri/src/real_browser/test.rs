//! Testes da superfície nativa do navegador (o Portal): o contrato do `Place` que chega do front e a lógica pura
//! que decide o que mudou, o que a máscara desenha e quando a vista é escondida.

use super::surface::{outline, rounded_parts, PathStep};
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
