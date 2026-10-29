//! A parte pura do simulador: o que se mostra de cada aparelho, os nomes de botões e teclas e as contas de
//! posição da tela. Sem CoreSimulator, para testar em qualquer sistema.

use serde::{Deserialize, Serialize};

/// Os estados do `SimDevice` (`state`): 0 criando, 1 desligado, 2 ligando, 3 ligado, 4 desligando.
pub const STATE_SHUTDOWN: u64 = 1;
pub const STATE_BOOTING: u64 = 2;
pub const STATE_BOOTED: u64 = 3;

/// Um aparelho do Xcode, como a lista do Safari ("Abrir Página com").
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub udid: String,
    pub name: String,
    /// `iOS 27.0`.
    pub runtime: String,
    /// `iphone` ou `ipad`.
    pub family: String,
    /// `shutdown`, `booting`, `booted`, `shuttingDown` ou `unknown`.
    pub state: String,
    /// A tela em pontos do iOS (`mainScreenSize` / `mainScreenScale` do tipo), para a moldura antes de ligar.
    pub width: f64,
    pub height: f64,
}

pub fn state_name(state: u64) -> &'static str {
    match state {
        STATE_SHUTDOWN => "shutdown",
        STATE_BOOTING => "booting",
        STATE_BOOTED => "booted",
        4 => "shuttingDown",
        _ => "unknown",
    }
}

/// Só iPhone e iPad entram na lista: relógio, TV e Vision Pro não têm o que fazer aqui.
pub fn family_of(name: &str, runtime: &str) -> Option<&'static str> {
    if !runtime.starts_with("iOS") {
        return None;
    }
    if name.starts_with("iPad") {
        Some("ipad")
    } else if name.starts_with("iPhone") {
        Some("iphone")
    } else {
        None
    }
}

/// iPhones primeiro, depois iPads; dentro de cada um, por nome e pelo iOS mais novo.
pub fn sort_devices(list: &mut [Device]) {
    list.sort_by(|a, b| {
        (a.family != "iphone")
            .cmp(&(b.family != "iphone"))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| b.runtime.cmp(&a.runtime))
    });
}

/// O aparelho pedido: o UDID exato, ou o nome (sem diferenciar maiúsculas). Nome repetido (o mesmo
/// modelo em dois iOS) prefere o ligado, depois o iOS mais novo.
pub fn pick<'a>(list: &'a [Device], wanted: &str) -> Result<&'a Device, String> {
    if let Some(device) = list.iter().find(|d| d.udid.eq_ignore_ascii_case(wanted)) {
        return Ok(device);
    }
    let mut named: Vec<&Device> = list.iter().filter(|d| d.name.eq_ignore_ascii_case(wanted)).collect();
    named.sort_by(|a, b| (b.state == "booted").cmp(&(a.state == "booted")).then_with(|| b.runtime.cmp(&a.runtime)));
    named.first().copied().ok_or_else(|| format!("Não encontrei o aparelho \"{wanted}\" no Xcode."))
}

/// Os botões físicos: o código da origem no Indigo (o mesmo que o SimulatorKit usa).
pub fn button_source(name: &str) -> Result<i32, String> {
    Ok(match name.to_ascii_lowercase().as_str() {
        "home" | "inicio" | "início" => 0x0,
        "lock" | "power" | "bloquear" => 0x1,
        "side" | "lateral" => 0xbb8,
        "siri" => 0x400002,
        "applepay" | "apple-pay" => 0x1f4,
        other => return Err(format!("Botão desconhecido: \"{other}\". Use home, lock, side ou siri.")),
    })
}

/// Teclas com nome → uso HID (página de teclado). As letras e números vão por [`char_usage`].
pub fn key_usage(name: &str) -> Result<u32, String> {
    let lower = name.to_ascii_lowercase();
    Ok(match lower.as_str() {
        "enter" | "return" => 0x28,
        "escape" | "esc" => 0x29,
        "delete" | "backspace" => 0x2a,
        "tab" => 0x2b,
        "space" => 0x2c,
        "right" => 0x4f,
        "left" => 0x50,
        "down" => 0x51,
        "up" => 0x52,
        "home" => return Err("Para o botão Início use `button home`; `key` é o teclado.".into()),
        _ => match lower.chars().collect::<Vec<_>>().as_slice() {
            [c] => return char_usage(*c).map(|(usage, _)| usage).ok_or_else(|| format!("Tecla desconhecida: \"{name}\".")),
            _ => return Err(format!("Tecla desconhecida: \"{name}\". Use enter, escape, delete, tab, space ou as setas.")),
        },
    })
}

/// Um caractere ASCII → (uso HID, precisa de Shift), no layout americano, que é o do teclado do simulador.
pub fn char_usage(c: char) -> Option<(u32, bool)> {
    const SHIFTED: &str = "~!@#$%^&*()_+{}|:\"<>?";
    const PLAIN: &str = "`1234567890-=[]\\;',./";
    Some(match c {
        'a'..='z' => (0x04 + (c as u32 - 'a' as u32), false),
        'A'..='Z' => (0x04 + (c as u32 - 'A' as u32), true),
        '1'..='9' => (0x1e + (c as u32 - '1' as u32), false),
        '0' => (0x27, false),
        ' ' => (0x2c, false),
        '\n' => (0x28, false),
        '\t' => (0x2b, false),
        _ => {
            // Os símbolos com Shift estão na mesma posição que o símbolo sem Shift da mesma tecla.
            let (index, shift) = match SHIFTED.find(c) {
                Some(i) => (i, true),
                None => (PLAIN.find(c)?, false),
            };
            let base = PLAIN.as_bytes()[index] as char;
            let usage = match base {
                '`' => 0x35,
                '-' => 0x2d,
                '=' => 0x2e,
                '[' => 0x2f,
                ']' => 0x30,
                '\\' => 0x31,
                ';' => 0x33,
                '\'' => 0x34,
                ',' => 0x36,
                '.' => 0x37,
                '/' => 0x38,
                d @ '1'..='9' => 0x1e + (d as u32 - '1' as u32),
                '0' => 0x27,
                _ => return None,
            };
            (usage, shift)
        }
    })
}

/// O texto como teclas: recusa o que não está no teclado americano (acento, emoji) em vez de digitar errado.
pub fn text_keys(text: &str) -> Result<Vec<(u32, bool)>, String> {
    text.chars()
        .map(|c| char_usage(c).ok_or_else(|| format!("O caractere \"{c}\" não está no teclado do simulador (só ASCII).")))
        .collect()
}

/// Um retângulo em pixels CSS do app (= pontos do macOS).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn is_empty(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

/// Onde a tela do aparelho está: `rect` relativo ao webview; `visible` e `holes` relativos à própria tela.
#[derive(Debug, Clone, Deserialize)]
pub struct Place {
    pub rect: Rect,
    /// O raio dos cantos da tela, já com o zoom do canvas.
    #[serde(default)]
    pub radius: f64,
    /// A parte à vista (o resto está fora do canvas ou atrás de outra aba). `None` = nada à vista.
    pub visible: Option<Rect>,
    /// O que do app está por cima (menus, diálogos): ali a tela não aparece nem recebe toque.
    #[serde(default)]
    pub holes: Vec<Rect>,
}

/// `r` menos os retângulos de `holes`, em pedaços retangulares.
pub fn subtract(r: Rect, holes: &[Rect]) -> Vec<Rect> {
    let mut parts = vec![r];
    for h in holes {
        parts = parts
            .into_iter()
            .flat_map(|p| {
                let (x0, y0, x1, y1) = (p.x.max(h.x), p.y.max(h.y), (p.x + p.width).min(h.x + h.width), (p.y + p.height).min(h.y + h.height));
                if x0 >= x1 || y0 >= y1 {
                    return vec![p];
                }
                let mut out = Vec::new();
                let push = |out: &mut Vec<Rect>, x: f64, y: f64, w: f64, h: f64| {
                    if w > 0.0 && h > 0.0 {
                        out.push(Rect { x, y, width: w, height: h });
                    }
                };
                push(&mut out, p.x, p.y, p.width, y0 - p.y);
                push(&mut out, p.x, y1, p.width, p.y + p.height - y1);
                push(&mut out, p.x, y0, x0 - p.x, y1 - y0);
                push(&mut out, x1, y0, p.x + p.width - x1, y1 - y0);
                out
            })
            .collect();
    }
    parts
}

/// O ponto (em pixels da view) → proporção 0..1 da tela, que é como o Indigo recebe o toque.
pub fn touch_ratio(x: f64, y: f64, width: f64, height: f64) -> Option<(f64, f64)> {
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(((x / width).clamp(0.0, 1.0), (y / height).clamp(0.0, 1.0)))
}

/// O ponto em pontos do iOS (o que `ags device tree` mostra) → proporção, dado o tamanho da tela em pontos.
pub fn point_ratio(x: f64, y: f64, screen: (f64, f64)) -> Result<(f64, f64), String> {
    let (w, h) = screen;
    if x < 0.0 || y < 0.0 || x > w || y > h {
        return Err(format!("O ponto ({x}, {y}) está fora da tela ({w}×{h} pontos)."));
    }
    touch_ratio(x, y, w, h).ok_or_else(|| "A tela do aparelho ainda não tem tamanho.".into())
}

/// Os pontos de um deslizamento: começo, `steps` passos intermediários e fim.
pub fn swipe_points(from: (f64, f64), to: (f64, f64), steps: u32) -> Vec<(f64, f64)> {
    let steps = steps.max(1);
    (0..=steps)
        .map(|i| {
            let t = f64::from(i) / f64::from(steps);
            (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t)
        })
        .collect()
}

/// A URL como o Safari do aparelho abre: sem esquema, `localhost`/IP vira `http://` e o resto `https://`.
pub fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Faltou a URL.".into());
    }
    if url.contains("://") {
        return Ok(url.to_string());
    }
    let host = url.split(['/', ':']).next().unwrap_or("");
    let local = host == "localhost" || host.ends_with(".localhost") || host.ends_with(".test") || host.parse::<std::net::IpAddr>().is_ok();
    Ok(format!("{}://{url}", if local { "http" } else { "https" }))
}

/// A saída de `ps -axo pid=,ppid=,command=` → o `launchd_sim` do aparelho `udid` e todos os descendentes. Pura.
pub fn process_tree(ps: &str, udid: &str) -> Vec<u32> {
    let rows: Vec<(u32, u32, &str)> = ps
        .lines()
        .filter_map(|line| {
            // O `ps` alinha as colunas com quantos espaços precisar: pid e ppid são as duas primeiras palavras, e o
            // comando é o resto da linha (com os espaços dele).
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let (ppid, command) = rest.trim_start().split_once(char::is_whitespace).unwrap_or((rest.trim_start(), ""));
            Some((pid.parse().ok()?, ppid.parse().ok()?, command.trim()))
        })
        .collect();
    let marker = format!("/Devices/{udid}/");
    let Some(root) = rows.iter().find(|(_, _, cmd)| cmd.starts_with("launchd_sim") && cmd.contains(&marker)).map(|r| r.0) else {
        return Vec::new();
    };
    let mut tree = vec![root];
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        tree.extend(rows.iter().filter(|r| r.1 == parent && !tree.contains(&r.0)).map(|r| r.0).collect::<Vec<_>>());
        i += 1;
    }
    tree
}
