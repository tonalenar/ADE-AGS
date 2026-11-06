//! Efeito por pixels: uma grade pequena de brilho de cada foto, para ver que um toque mudou a tela mesmo quando o
//! texto do OCR é o mesmo. O caso medido: trocar o tema claro/escuro do Nutriton muda só a paleta, e um verificador
//! só por estrutura (texto, árvore) disse "nenhum efeito" para um toque que funcionou. Puro.

/// Colunas e linhas da grade. 24 × 48 = 1.152 células: nítido para uma barra ou um painel, barato de guardar.
pub(crate) const COLS: usize = 24;
pub(crate) const ROWS: usize = 48;
/// Uma célula mudou quando o brilho médio dela andou mais que isto (0..255): ignora o cursor piscando e o
/// antisserrilhado, pega um botão que acendeu.
const CELL_DELTA: u8 = 24;
/// A tela mudou quando pelo menos esta fração das células mudou.
const CHANGED: f64 = 0.02;
/// Mais escura ou mais clara: o brilho médio da tela inteira andou pelo menos isto (0..1).
const LUMA_DELTA: f64 = 0.08;

/// O brilho médio de cada célula, linha a linha.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thumb(pub Vec<u8>);

/// O que se espera ver nos pixels, comparado com a primeira foto do `act`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visual {
    /// Alguma parte visível da tela mudou.
    Changed,
    /// A tela ficou mais escura (tema escuro, modo noturno).
    Darker,
    /// A tela ficou mais clara.
    Lighter,
}

impl Visual {
    /// `--expect visual:changed|darker|lighter`.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.strip_prefix("visual:")?.trim() {
            "changed" => Some(Self::Changed),
            "darker" => Some(Self::Darker),
            "lighter" => Some(Self::Lighter),
            _ => None,
        }
    }
}

/// A grade a partir de pixels BGRA (linhas de `width * 4` bytes). Amostra um pixel a cada `step` em cada direção:
/// numa tela de 1170 × 2532 são ~80 mil leituras, menos de um milissegundo.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn thumb_from_bgra(data: &[u8], width: usize, height: usize) -> Option<Thumb> {
    if width < COLS || height < ROWS || data.len() < width * height * 4 {
        return None;
    }
    let step = (width.min(height) / 200).max(1);
    let mut sum = vec![0u64; COLS * ROWS];
    let mut count = vec![0u64; COLS * ROWS];
    for y in (0..height).step_by(step) {
        let row = y * ROWS / height;
        for x in (0..width).step_by(step) {
            let i = (y * width + x) * 4;
            let (b, g, r) = (data[i] as u64, data[i + 1] as u64, data[i + 2] as u64);
            // Rec. 601 em inteiros: 0,299 R + 0,587 G + 0,114 B.
            let luma = (299 * r + 587 * g + 114 * b) / 1000;
            let cell = row * COLS + x * COLS / width;
            sum[cell] += luma;
            count[cell] += 1;
        }
    }
    Some(Thumb(sum.iter().zip(&count).map(|(s, c)| (s / (*c).max(1)) as u8).collect()))
}

/// O quanto a tela mudou entre duas grades: a fração das células que mudou e quanto o brilho médio andou (-1..1).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Effect {
    pub changed: f64,
    pub luma: f64,
}

use serde::Serialize;

pub(crate) fn effect(before: &Thumb, after: &Thumb) -> Option<Effect> {
    if before.0.len() != after.0.len() || before.0.is_empty() {
        return None;
    }
    let n = before.0.len() as f64;
    let changed = before.0.iter().zip(&after.0).filter(|(a, b)| a.abs_diff(**b) > CELL_DELTA).count() as f64 / n;
    let mean = |t: &Thumb| t.0.iter().map(|v| f64::from(*v)).sum::<f64>() / n / 255.0;
    Some(Effect { changed, luma: mean(after) - mean(before) })
}

/// Se a expectativa visual vale entre a primeira foto do `act` e a atual. Sem as duas grades, não vale (fica não
/// verificado, nunca "feito" por falta de dado).
pub(crate) fn satisfied(want: Visual, first: Option<&Thumb>, now: Option<&Thumb>) -> bool {
    let Some(e) = first.zip(now).and_then(|(a, b)| effect(a, b)) else { return false };
    match want {
        Visual::Changed => e.changed >= CHANGED,
        Visual::Darker => e.luma <= -LUMA_DELTA,
        Visual::Lighter => e.luma >= LUMA_DELTA,
    }
}

#[cfg(test)]
mod test {
    use super::*;

    /// Uma tela BGRA lisa com um retângulo de outra cor.
    fn screen(w: usize, h: usize, bg: [u8; 3], rect: Option<(usize, usize, usize, usize, [u8; 3])>) -> Vec<u8> {
        let mut data = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let c = match rect {
                    Some((x0, y0, x1, y1, c)) if x >= x0 && x < x1 && y >= y0 && y < y1 => c,
                    _ => bg,
                };
                let i = (y * w + x) * 4;
                data[i..i + 4].copy_from_slice(&[c[2], c[1], c[0], 255]);
            }
        }
        data
    }

    #[test]
    fn troca_so_de_paleta_e_efeito_visivel_e_escurece() {
        // Tema claro → escuro: a mesma estrutura (um cartão no meio), outra paleta. O texto do OCR seria igual.
        let light = thumb_from_bgra(&screen(390, 844, [242, 242, 247], Some((40, 300, 350, 500, [255, 255, 255]))), 390, 844).unwrap();
        let dark = thumb_from_bgra(&screen(390, 844, [0, 0, 0], Some((40, 300, 350, 500, [28, 28, 30]))), 390, 844).unwrap();
        let e = effect(&light, &dark).unwrap();
        assert!(e.changed > 0.9 && e.luma < -0.8, "{e:?}");
        assert!(satisfied(Visual::Changed, Some(&light), Some(&dark)));
        assert!(satisfied(Visual::Darker, Some(&light), Some(&dark)));
        assert!(!satisfied(Visual::Lighter, Some(&light), Some(&dark)));
    }

    #[test]
    fn mesma_tela_nao_muda_e_sem_pixels_nunca_conta_como_feito() {
        let a = thumb_from_bgra(&screen(390, 844, [242, 242, 247], None), 390, 844).unwrap();
        assert!(!satisfied(Visual::Changed, Some(&a), Some(&a)));
        assert!(!satisfied(Visual::Changed, None, Some(&a)));
        assert!(!satisfied(Visual::Darker, Some(&a), None));
    }

    #[test]
    fn um_botao_que_acende_e_pouco_mas_conta_e_um_cursor_piscando_nao() {
        let off = thumb_from_bgra(&screen(390, 844, [255, 255, 255], None), 390, 844).unwrap();
        // Um botão de ~8% da tela que ficou azul.
        let on = thumb_from_bgra(&screen(390, 844, [255, 255, 255], Some((20, 700, 370, 780, [0, 122, 255]))), 390, 844).unwrap();
        assert!(satisfied(Visual::Changed, Some(&off), Some(&on)));
        // Um cursor de 2 px piscando não muda a média de nenhuma célula o bastante.
        let caret = thumb_from_bgra(&screen(390, 844, [255, 255, 255], Some((100, 200, 102, 220, [0, 0, 0]))), 390, 844).unwrap();
        assert!(!satisfied(Visual::Changed, Some(&off), Some(&caret)));
    }

    #[test]
    fn nome_da_expectativa() {
        assert_eq!(Visual::parse("visual:changed"), Some(Visual::Changed));
        assert_eq!(Visual::parse("visual:darker"), Some(Visual::Darker));
        assert_eq!(Visual::parse("visual:lighter"), Some(Visual::Lighter));
        assert_eq!(Visual::parse("visual:azul"), None);
        assert_eq!(Visual::parse("text:x"), None);
    }
}
