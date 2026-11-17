//! Decisões puras para desenhar a superfície nativa do navegador, sem AppKit: o que mudou desde o último `place`, a
//! máscara, o contorno dela e quando a vista some.

/// Uma parte visível da vista, com os cantos que devem ser arredondados.
#[derive(Debug, PartialEq)]
pub(super) struct RoundedPart {
    pub rect: [f64; 4],
    /// Ordem: superior esquerdo, superior direito, inferior direito, inferior esquerdo.
    pub corners: [bool; 4],
    pub radius: f64,
}

/// As partes à vista, cada uma um retângulo. Só arredonda os cantos que tocam a borda externa da vista: um canto
/// encostado num menu por cima continua reto.
pub(super) fn rounded_parts(width: i32, height: i32, parts: &[[i32; 4]], radius: f64) -> Vec<RoundedPart> {
    let (width, height) = (width.max(0), height.max(0));
    parts.iter().filter_map(|[left, top, right, bottom]| {
        let l = (*left).clamp(0, width);
        let t = (*top).clamp(0, height);
        let r = (*right).clamp(l, width);
        let b = (*bottom).clamp(t, height);
        if r <= l || b <= t { return None; }
        Some(RoundedPart {
            rect: [l as f64, t as f64, (r - l) as f64, (b - t) as f64],
            corners: [l == 0 && t == 0, r == width && t == 0, r == width && b == height, l == 0 && b == height],
            radius: radius.min(((r - l) as f64 / 2.0).min((b - t) as f64 / 2.0)).max(0.0),
        })
    }).collect()
}

/// Um passo do contorno de uma parte. `Arc` é um canto arredondado: `corner` é o canto da caixa e `end`, onde o
/// arco termina (o arco é tangente às duas bordas).
#[derive(Debug, PartialEq)]
pub(super) enum PathStep {
    Move([f64; 2]),
    Line([f64; 2]),
    Arc { corner: [f64; 2], end: [f64; 2], radius: f64 },
    Close,
}

/// O contorno de uma parte, no sentido horário da tela (y cresce para baixo).
pub(super) fn outline(part: &RoundedPart) -> Vec<PathStep> {
    let [x, y, width, height] = part.rect;
    let [top_left, top_right, bottom_right, bottom_left] = part.corners;
    let r = part.radius;
    let (right, bottom) = (x + width, y + height);
    let inset = |rounded: bool| if rounded { r } else { 0.0 };
    let mut steps = vec![PathStep::Move([x + inset(top_left), y]), PathStep::Line([right - inset(top_right), y])];
    if top_right { steps.push(PathStep::Arc { corner: [right, y], end: [right, y + r], radius: r }); }
    steps.push(PathStep::Line([right, bottom - inset(bottom_right)]));
    if bottom_right { steps.push(PathStep::Arc { corner: [right, bottom], end: [right - r, bottom], radius: r }); }
    steps.push(PathStep::Line([x + inset(bottom_left), bottom]));
    if bottom_left { steps.push(PathStep::Arc { corner: [x, bottom], end: [x, bottom - r], radius: r }); }
    steps.push(PathStep::Line([x, y + inset(top_left)]));
    if top_left { steps.push(PathStep::Arc { corner: [x, y], end: [x + r, y], radius: r }); }
    steps.push(PathStep::Close);
    steps
}

/// O que foi aplicado ao Portal no último `place`, para não refazer o que não mudou.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct PlaceState {
    pub frame: [i32; 4],
    pub parts: Vec<[i32; 4]>,
    pub radius: f64,
    pub zoom: f64,
}

/// O que um `place` precisa reaplicar ao Portal e ao navegador.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct PlaceChanges {
    pub frame: bool,
    pub mask: bool,
    pub zoom: bool,
    pub resized: bool,
}

/// Compara o lugar novo com o último aplicado. Sem último, tudo é aplicado.
pub(super) fn diff_place(last: Option<&PlaceState>, next: &PlaceState) -> PlaceChanges {
    let Some(last) = last else {
        return PlaceChanges { frame: true, mask: true, zoom: true, resized: true };
    };
    let size_changed = last.frame[2..] != next.frame[2..];
    PlaceChanges {
        frame: last.frame != next.frame,
        mask: size_changed || last.parts != next.parts || last.radius != next.radius,
        zoom: last.zoom != next.zoom,
        resized: size_changed,
    }
}

/// Decide se a vista fica escondida depois de um `place`. Um quadro sem recorte à vista (uma transição, um
/// layout intermediário) não esconde: a página continua na tela com a última máscara. Dois seguidos sem recorte
/// escondem. Um `visible: false` explícito (a desmontagem) esconde na hora. Devolve o estado novo.
pub(super) fn empty_clip_visibility(empty_count: &mut u8, hidden: &mut bool, empty: bool, explicitly_hidden: bool) -> bool {
    if explicitly_hidden {
        *empty_count = 0;
        *hidden = true;
    } else if empty {
        *empty_count = empty_count.saturating_add(1);
        if *empty_count >= 2 { *hidden = true; }
    } else {
        *empty_count = 0;
        *hidden = false;
    }
    *hidden
}
