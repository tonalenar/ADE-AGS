//! Zonas da tela do iOS que cobrem o conteúdo: o teclado e a barra flutuante do app (abas, ações). Puro, só sobre
//! o OCR local (caixas em proporção da foto, origem no topo).
//!
//! Medido nos testes do usuário com o Nutriton (iPhone 17e, 2026-11-04): um checkbox em y=756 ficava sob a barra
//! flutuante em y=757, e o toque no centro do texto caía na barra; um campo coberto pelo teclado não tinha onde
//! tocar; um elemento cortado na borda de baixo foi tocado sem rolar antes. Nos três casos o certo é rolar o
//! conteúdo até o alvo sair da zona coberta e olhar de novo, não tocar.
use super::ios::Label;

/// O que cobre o ponto escolhido.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Cover {
    /// O teclado (letras ou teclado numérico) e a barra de sugestões acima dele.
    Keyboard,
    /// Uma linha de rótulos curtos colada embaixo (abas, barra de ações flutuante).
    Bar,
    /// O texto está cortado na borda de baixo: o resto do controle está fora da tela.
    Edge,
}

/// A área livre termina aqui (proporção da altura) e o motivo.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Zone {
    pub cover: Cover,
    pub top: f64,
}

/// Teclas do teclado numérico do iOS: o OCR lê os dígitos e as letras embaixo de cada um.
const KEYPAD: [&str; 8] = ["abc", "def", "ghi", "jkl", "mno", "pqrs", "tuv", "wxyz"];
/// Linhas dos teclados de letras (QWERTY, QWERTZ, AZERTY), sem espaços: o OCR às vezes lê a linha inteira junta.
const ROWS: [&str; 8] = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "qwertzuiop", "yxcvbnm", "azertyuiop", "qsdfghjklm", "wxcvbn"];
/// Quantas teclas, no mínimo, para chamar de teclado (um "1" solto não é).
const MIN_KEYS: usize = 6;
/// Acima da primeira tecla ficam a borda do teclado e a barra de sugestões, que também digita.
const KEYBOARD_MARGIN: f64 = 0.06;
/// O ícone de uma aba fica acima do texto dela, e o fundo da barra ainda um pouco acima.
const BAR_MARGIN: f64 = 0.05;
/// A barra fica no último quinto da tela.
const BAR_FROM: f64 = 0.80;
/// Texto cuja base encosta aqui está cortado pela borda de baixo.
const EDGE: f64 = 0.985;

fn key_like(text: &str) -> bool {
    let t: String = text.split_whitespace().collect::<String>().to_lowercase();
    if t.chars().count() == 1 {
        return t.chars().all(char::is_alphanumeric);
    }
    KEYPAD.contains(&t.as_str())
        || (t.chars().count() >= 5 && t.chars().all(char::is_alphabetic) && ROWS.iter().any(|row| row.contains(&t)))
}

/// O topo do teclado, se há um aberto: pelo menos `MIN_KEYS` teclas na metade de baixo. Uma linha inteira lida junta
/// ("QWERTYUIOP") vale por uma linha de teclas.
pub(super) fn keyboard_top(labels: &[Label]) -> Option<f64> {
    let keys: Vec<&Label> = labels.iter().filter(|l| l.top >= 0.45 && key_like(&l.text)).collect();
    let weight: usize = keys
        .iter()
        .map(|l| if l.text.split_whitespace().collect::<String>().chars().count() >= 5 { MIN_KEYS / 2 } else { 1 })
        .sum();
    (weight >= MIN_KEYS).then(|| keys.iter().map(|l| l.top).fold(1.0, f64::min) - KEYBOARD_MARGIN)
}

fn center_y(l: &Label) -> f64 {
    (l.top + l.bottom) / 2.0
}

/// A barra de baixo: a linha mais baixa de pelo menos 3 rótulos curtos na mesma altura, espalhados pela largura.
/// Devolve o topo dela e os índices dos rótulos que são a própria barra (tocar neles é tocar na barra, e vale).
pub(super) fn bar(labels: &[Label]) -> Option<(f64, Vec<usize>)> {
    // Uma tecla nunca é aba: a última linha do teclado numérico ("PQRS TUV WXYZ") parecia uma barra (medido no OCR
    // do Nutriton, 2026-11-05).
    let low: Vec<usize> = (0..labels.len())
        .filter(|&i| center_y(&labels[i]) >= BAR_FROM && labels[i].text.trim().chars().count() <= 16 && !key_like(&labels[i].text))
        .collect();
    let mut best: Option<(f64, Vec<usize>)> = None;
    for &i in &low {
        let row: Vec<usize> = low.iter().copied().filter(|&j| (center_y(&labels[j]) - center_y(&labels[i])).abs() <= 0.015).collect();
        let left = row.iter().map(|&j| labels[j].left).fold(1.0, f64::min);
        let right = row.iter().map(|&j| labels[j].right).fold(0.0, f64::max);
        if row.len() < 3 || right - left < 0.45 {
            continue;
        }
        let top = row.iter().map(|&j| labels[j].top).fold(1.0, f64::min) - BAR_MARGIN;
        if best.as_ref().is_none_or(|(t, _)| top > *t) {
            best = Some((top, row));
        }
    }
    best
}

/// Se o toque escolhido cai numa zona coberta. `chosen` é o índice do rótulo do OCR que o Jev escolheu. Sem ele (um
/// ícone pela caixa desenhada) nada é "coberto": um ícone na barra é a própria barra, e um ícone no teclado é uma
/// tecla (apagar, globo), que `keyboard_key` manda perguntar à pessoa.
pub(super) fn covered(point: (f64, f64), chosen: Option<usize>, labels: &[Label]) -> Option<Zone> {
    let (_, y) = point;
    let label = chosen.and_then(|i| labels.get(i))?;
    if let Some(top) = keyboard_top(labels) {
        if y >= top {
            // Uma tecla não é coberta: é o teclado. Quem decide se pode tocá-la é `keyboard_key`.
            return (!key_like(&label.text)).then_some(Zone { cover: Cover::Keyboard, top });
        }
    }
    if let Some((top, row)) = bar(labels) {
        if y >= top && !chosen.is_some_and(|i| row.contains(&i)) {
            return Some(Zone { cover: Cover::Bar, top });
        }
    }
    (label.bottom >= EDGE).then_some(Zone { cover: Cover::Edge, top: 0.92 })
}

/// Um toque numa tecla digita sem `--fill`: o texto só pode vir de lá, então isso sempre pede a pessoa.
pub(super) fn keyboard_key(point: Option<(f64, f64)>, labels: &[Label]) -> bool {
    point.is_some_and(|(_, y)| keyboard_top(labels).is_some_and(|top| y >= top))
}

/// O traço que sobe o conteúdo até o alvo ficar acima da zona, com folga: começa na área livre (nunca no teclado
/// nem na barra) e anda o quanto falta, entre 12% da tela e o espaço livre que há. `None` sem espaço para rolar.
pub(super) fn reveal_line(point_y: f64, zone: Zone) -> Option<((f64, f64), (f64, f64))> {
    let start = (zone.top - 0.05).min(0.75);
    let wanted = point_y - (zone.top - 0.2);
    let room = start - 0.12;
    if room < 0.12 {
        return None;
    }
    let shift = wanted.clamp(0.12, room);
    Some(((0.5, start), (0.5, start - shift)))
}

#[cfg(test)]
mod test {
    use super::*;

    fn l(text: &str, left: f64, top: f64, right: f64, bottom: f64) -> Label {
        Label { text: text.into(), left, right, top, bottom }
    }
    /// A tela do Nutriton medida (2026-11-04): conteúdo, um checkbox colado na barra flutuante e a barra de abas.
    fn nutriton_com_barra() -> Vec<Label> {
        vec![
            l("Hidratação · hoje", 0.05, 0.10, 0.45, 0.13),
            l("Meta diária", 0.05, 0.30, 0.30, 0.32),
            l("Beber 2 copos antes do almoço", 0.15, 0.875, 0.70, 0.898),
            l("Hoje", 0.08, 0.93, 0.18, 0.95),
            l("Plano", 0.30, 0.93, 0.42, 0.95),
            l("Água", 0.55, 0.93, 0.66, 0.95),
            l("Perfil", 0.80, 0.93, 0.92, 0.95),
        ]
    }
    /// O teclado numérico do iOS sobre o formulário (o OCR lê os dígitos e as letras de cada tecla).
    fn com_teclado_numerico() -> Vec<Label> {
        let mut v = vec![l("Quantidade", 0.05, 0.30, 0.30, 0.32), l("Observação", 0.05, 0.70, 0.30, 0.72)];
        for (i, (d, s)) in [("1", ""), ("2", "ABC"), ("3", "DEF"), ("4", "GHI"), ("5", "JKL"), ("6", "MNO")].iter().enumerate() {
            let x = 0.1 + (i % 3) as f64 * 0.33;
            let y = 0.64 + (i / 3) as f64 * 0.05;
            v.push(l(d, x, y, x + 0.03, y + 0.02));
            if !s.is_empty() {
                v.push(l(s, x, y + 0.022, x + 0.05, y + 0.03));
            }
        }
        v
    }

    #[test]
    fn checkbox_colado_na_barra_flutuante_e_coberto_e_a_aba_nao() {
        let labels = nutriton_com_barra();
        let (top, row) = bar(&labels).expect("barra de abas");
        assert_eq!(row.len(), 4);
        assert!(top < 0.887 && top > 0.85, "o topo da barra fica acima do texto das abas: {top}");
        let zone = covered((0.42, 0.887), Some(2), &labels).expect("o checkbox está sob a barra");
        assert_eq!(zone.cover, Cover::Bar);
        // Tocar na própria aba é tocar na barra: vale.
        assert_eq!(covered((0.36, 0.94), Some(4), &labels), None);
        // Um ícone sem texto (pela caixa) na barra também é a barra.
        assert_eq!(covered((0.36, 0.91), None, &labels), None);
        // O conteúdo de cima segue livre.
        assert_eq!(covered((0.17, 0.31), Some(1), &labels), None);
    }

    #[test]
    fn campo_sob_o_teclado_e_coberto_e_tocar_numa_tecla_e_digitar() {
        let labels = com_teclado_numerico();
        let top = keyboard_top(&labels).expect("teclado numérico");
        assert!(top < 0.64);
        assert_eq!(covered((0.17, 0.71), Some(1), &labels).map(|z| z.cover), Some(Cover::Keyboard));
        assert_eq!(covered((0.17, 0.31), Some(0), &labels), None);
        assert!(keyboard_key(Some((0.11, 0.65)), &labels), "uma tecla pede a pessoa");
        assert!(!keyboard_key(Some((0.17, 0.31)), &labels));
        // Sem teclado, nada de tecla: um "1" solto num calendário não é teclado.
        assert!(!keyboard_key(Some((0.5, 0.9)), &[l("1", 0.5, 0.9, 0.52, 0.92)]));
    }

    /// As caixas que o Vision leu na foto do Nutriton com o teclado numérico aberto (2026-11-05, `bancada` abaixo).
    #[test]
    fn ocr_real_do_teclado_numerico_tecla_pede_a_pessoa_e_a_ultima_linha_nao_e_barra() {
        let labels = vec![
            l("Hidratação hoje", 0.029, 0.083, 0.377, 0.105),
            l("250 ml", 0.083, 0.291, 0.466, 0.348),
            l("+ Adicionar", 0.662, 0.294, 0.897, 0.316),
            l("1", 0.142, 0.684, 0.176, 0.706),
            l("2", 0.475, 0.684, 0.510, 0.706),
            l("ABC", 0.461, 0.711, 0.529, 0.724),
            l("5", 0.475, 0.749, 0.510, 0.771),
            l("JKL", 0.461, 0.776, 0.525, 0.789),
            l("4", 0.142, 0.749, 0.181, 0.769),
            l("GHI", 0.127, 0.776, 0.196, 0.787),
            l("7", 0.137, 0.814, 0.176, 0.836),
            l("PQRS", 0.113, 0.839, 0.206, 0.854),
            l("TUV", 0.461, 0.839, 0.529, 0.852),
            l("9", 0.809, 0.814, 0.848, 0.834),
            l("WXYZ", 0.784, 0.839, 0.877, 0.852),
        ];
        let top = keyboard_top(&labels).expect("teclado");
        assert!(top > 0.5 && top < 0.684, "{top}");
        assert_eq!(bar(&labels), None, "PQRS/TUV/WXYZ são teclas, não abas");
        for i in 3..labels.len() {
            let c = ((labels[i].left + labels[i].right) / 2.0, (labels[i].top + labels[i].bottom) / 2.0);
            assert_eq!(covered(c, Some(i), &labels), None, "{}", labels[i].text);
            assert!(keyboard_key(Some(c), &labels), "{}", labels[i].text);
        }
        // O campo e o botão de cima seguem tocáveis, sem pergunta.
        assert_eq!(covered((0.78, 0.305), Some(2), &labels), None);
        assert!(!keyboard_key(Some((0.78, 0.305)), &labels));
    }

    #[test]
    fn linha_do_teclado_lida_junta_conta_como_teclado() {
        let labels = vec![l("QWERTYUIOP", 0.02, 0.70, 0.98, 0.73), l("ASDFGHJKL", 0.05, 0.76, 0.95, 0.79), l("Nome", 0.05, 0.3, 0.2, 0.32)];
        assert!(keyboard_top(&labels).is_some());
    }

    #[test]
    fn texto_cortado_na_borda_de_baixo_pede_rolar() {
        let labels = vec![l("Salvar alterações", 0.3, 0.97, 0.7, 0.995), l("Nome", 0.05, 0.3, 0.2, 0.32)];
        assert_eq!(covered((0.5, 0.98), Some(0), &labels).map(|z| z.cover), Some(Cover::Edge));
    }

    /// Bancada com o OCR de verdade (Vision, local, sem cota): o que o teclado e a barra viram numa foto. Só lê a
    /// imagem: `COVER_PNG=<foto.png> cargo test --lib computer_use::cover::test::bancada -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "precisa de uma foto (COVER_PNG); roda o OCR local"]
    fn bancada_cobertura_numa_foto() {
        let path = std::path::PathBuf::from(std::env::var("COVER_PNG").expect("COVER_PNG"));
        let t = std::time::Instant::now();
        // Direto no Vision, sem esperar o aquecimento do `ocr` do app.
        let labels = super::super::capture::read_text(&path).expect("OCR");
        eprintln!("OCR: {} textos em {:.0} ms", labels.len(), t.elapsed().as_secs_f64() * 1000.);
        for (i, l) in labels.iter().enumerate() {
            eprintln!("  t{i:<2} {:<28} y {:.3}–{:.3} x {:.3}–{:.3} tecla={}", l.text, l.top, l.bottom, l.left, l.right, key_like(&l.text));
        }
        eprintln!("teclado: {:?}", keyboard_top(&labels));
        eprintln!("barra: {:?}", bar(&labels));
        for (i, l) in labels.iter().enumerate() {
            let point = ((l.left + l.right) / 2.0, (l.top + l.bottom) / 2.0);
            if let Some(zone) = covered(point, Some(i), &labels) {
                eprintln!("  coberto: t{i} {:?} → {:?}, traço {:?}", l.text, zone, reveal_line(point.1, zone));
            }
            if keyboard_key(Some(point), &labels) {
                eprintln!("  tecla (pede a pessoa): t{i} {:?}", l.text);
            }
        }
    }

    #[test]
    fn o_traco_comeca_na_area_livre_e_sobe_o_alvo_acima_da_zona() {
        let zone = Zone { cover: Cover::Keyboard, top: 0.58 };
        let ((_, from), (_, to)) = reveal_line(0.71, zone).unwrap();
        assert!(from < zone.top, "o dedo nunca começa no teclado");
        let after = 0.71 - (from - to);
        assert!(after < zone.top, "o alvo termina acima do teclado: {after}");
        // Teclado quase na tela toda: sem espaço para rolar, não inventa traço.
        assert_eq!(reveal_line(0.5, Zone { cover: Cover::Keyboard, top: 0.2 }), None);
    }
}
