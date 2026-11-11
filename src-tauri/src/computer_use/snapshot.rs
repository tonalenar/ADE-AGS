//! SnapShot do Mac: foto pontual da tela principal, de outra tela ou de uma janela, anexada ao rascunho.
//!
//! - Listagem: `snapshot/list.swift` roda com `/usr/bin/swift -e`, como o `desk_input.swift`. Ele só lê telas
//!   ativas e janelas visíveis (metadados): não captura e não pede permissão. Filtro e numeração ficam aqui, puros.
//! - Captura: a tela principal segue o comando de sempre (`screencapture -x -t png`). Outra tela usa `-D 2`, e só
//!   quando há exatamente duas telas: o manual do macOS diz "1 é principal, 2 secundária". Com três ou mais, a
//!   numeração das secundárias não é documentada e elas ficam bloqueadas. Uma janela usa `-l <id>`.
//! - Conferência: a foto de outra tela precisa ter o tamanho dela, em pixels ou em pontos (tela girada aceita).
//!   Se não bater, a foto sai do disco e nada é anexado. Com dois monitores iguais, o tamanho não distingue as
//!   telas: a escolha depende só da numeração documentada, ainda não verificada com dois monitores.
//! - Permissão: outra tela e janelas só saem com a Gravação de Tela autorizada (`titles` na listagem). Sem ela,
//!   ficam bloqueadas e o seletor explica por quê. A tela principal segue como antes.
//! - Metadados: `ADE-AGS_SnapShot_<carimbo>_<uuid>.json` ao lado do PNG, com app, título e número da tela. O
//!   composer lê esse arquivo para legendar o anexo (`snapshot_info`), mesmo depois de recarregar a janela.
//!
//! Fora desta fatia: OCR da captura e árvore de acessibilidade (ver `docs/ade-ags/GRAVACAO_DE_TELA.md`).
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use std::time::Duration;

pub const LIST_SWIFT: &str = include_str!("snapshot/list.swift");
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_INFO_BYTES: u64 = 4096;
const MAX_APP_CHARS: usize = 200;
const MAX_WINDOWS: usize = 150;
const MIN_WINDOW_SIDE: f64 = 50.0;
const MAX_DISPLAY_NUMBER: u32 = 16;
const PREFIX: &str = "ADE-AGS_SnapShot_";
const SIDECAR_VERSION: u32 = 1;
const PERMISSION_MSG: &str = "O preflight do macOS não detectou a Gravação de Tela. Confira Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema. Se ADE AGS já estiver habilitada, remova-a da lista e adicione-a novamente para renovar o requisito TCC após a troca da assinatura.";
const NUMBERING_MSG: &str = "Com três ou mais telas, o macOS não documenta a numeração do screencapture para as telas secundárias. A ADE não captura essas telas; a principal e, com duas telas, a secundária seguem disponíveis.";
const GONE_DISPLAY_MSG: &str = "Esta tela não está mais conectada. Atualize a lista e escolha de novo.";
const GONE_WINDOW_MSG: &str = "Esta janela não está mais disponível. Atualize a lista e escolha de novo.";
const MISMATCH_MSG: &str = "A foto não tem o tamanho da tela escolhida, então não anexei nada. Atualize a lista e tente de novo.";
const LIST_FAILED_MSG: &str = "Não consegui listar as telas e as janelas agora.";
#[cfg(not(target_os = "macos"))]
const ONLY_MAC_MSG: &str = "A captura pontual da tela está disponível no macOS nesta versão.";

/// O que a pessoa escolheu no seletor. `Main` é o padrão, o mesmo do atalho `Cmd+Shift+S`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SnapshotTarget {
    Main,
    Display { id: u32 },
    Window { id: u32 },
}

/// Por que uma tela ou janela não pode ser capturada agora.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocked {
    Permission,
    Numbering,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayItem {
    pub id: u32,
    pub main: bool,
    /// O número que o `screencapture -D` recebe; `None` quando o macOS não o documenta para esta tela.
    pub number: Option<u32>,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub points_width: u32,
    pub points_height: u32,
    pub capturable: bool,
    pub blocked: Option<Blocked>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowItem {
    pub id: u32,
    pub app: String,
    /// Só existe com a Gravação de Tela autorizada.
    pub title: Option<String>,
    pub capturable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub titles: bool,
    pub displays: Vec<DisplayItem>,
    pub windows: Vec<WindowItem>,
}

/// A captura já decidida: o argumento do `screencapture` e o que vai para o JSON ao lado.
#[derive(Clone, Debug, PartialEq)]
pub enum Plan {
    Main,
    Display { number: u32, pixels: (u32, u32), points: (u32, u32) },
    Window { id: u32, app: String, title: Option<String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Display,
    Window,
}

/// O JSON guardado ao lado do PNG. Só fatos da captura, nenhum conteúdo de tela.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub version: u32,
    pub scope: Scope,
    pub app: Option<String>,
    pub title: Option<String>,
    pub display_number: Option<u32>,
    pub captured_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawListing {
    titles: bool,
    displays: Vec<RawDisplay>,
    windows: Vec<RawWindow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDisplay {
    id: u32,
    main: bool,
    w: f64,
    h: f64,
    pixel_width: u32,
    pixel_height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawWindow {
    id: u32,
    app: Option<String>,
    title: Option<String>,
    layer: i64,
    w: f64,
    h: f64,
}

/// Lê a saída do helper e devolve a listagem numerada e filtrada. Pura: testada com saídas sintéticas.
pub fn parse_listing(raw: &str) -> Result<Listing, String> {
    let raw: RawListing = serde_json::from_str(raw).map_err(|_| LIST_FAILED_MSG.to_string())?;
    let displays = number_displays(&raw.displays, raw.titles)?;
    let titles = raw.titles;
    let windows = raw
        .windows
        .into_iter()
        .filter_map(|w| window_item(w, titles))
        .take(MAX_WINDOWS)
        .collect();
    Ok(Listing { titles, displays, windows })
}

/// A numeração das telas. A principal é `1` (documentado). Com exatamente duas telas, a outra é `2` (documentado:
/// "2 secondary"). Com três ou mais, a ordem das secundárias não é documentada: nenhum número é inventado.
fn number_displays(raw: &[RawDisplay], titles: bool) -> Result<Vec<DisplayItem>, String> {
    if raw.is_empty() {
        return Err("Nenhuma tela ativa foi encontrada.".into());
    }
    // Tamanho em pontos é obrigatório. Pixel zerado (o macOS não deu o modo) não derruba a lista: a conferência
    // da foto aceita o tamanho em pontos, então a tela segue capturável sem a medida em pixels.
    if raw.iter().any(|d| !(d.w > 0.0 && d.h > 0.0)) {
        return Err(LIST_FAILED_MSG.into());
    }
    if !raw.iter().any(|d| d.main) {
        return Err("Nenhuma tela principal foi encontrada.".into());
    }
    let secundarias = raw.iter().filter(|d| !d.main).count();
    Ok(raw
        .iter()
        .map(|d| {
            let (number, blocked): (Option<u32>, Option<Blocked>) = if d.main {
                (Some(1), None)
            } else if secundarias != 1 {
                (None, Some(Blocked::Numbering))
            } else if !titles {
                (Some(2), Some(Blocked::Permission))
            } else {
                (Some(2), None)
            };
            DisplayItem {
                id: d.id,
                main: d.main,
                number,
                pixel_width: d.pixel_width,
                pixel_height: d.pixel_height,
                points_width: d.w.round() as u32,
                points_height: d.h.round() as u32,
                capturable: blocked.is_none(),
                blocked,
            }
        })
        .collect())
}

/// Janela de aplicativo de verdade: camada normal, com tamanho e app. Sem permissão, o título nunca passa.
fn window_item(raw: RawWindow, titles: bool) -> Option<WindowItem> {
    if raw.id == 0 || raw.layer != 0 || raw.w < MIN_WINDOW_SIDE || raw.h < MIN_WINDOW_SIDE {
        return None;
    }
    let app = clean_text(raw.app.as_deref().unwrap_or(""), MAX_APP_CHARS)?;
    let title = titles.then(|| clean_text(raw.title.as_deref().unwrap_or(""), MAX_TITLE_CHARS)).flatten();
    Some(WindowItem { id: raw.id, app, title, capturable: titles })
}

/// Tira controle e espaço das pontas; vazio vira nada; corta no teto de caracteres. Pura.
fn clean_text(raw: &str, max: usize) -> Option<String> {
    let text: String = raw.chars().filter(|c| !c.is_control()).collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(max).collect())
}

/// Decide o que capturar a partir da listagem. Recusa o que não pode, com a mensagem que a pessoa precisa ver.
pub fn plan_for(listing: &Listing, target: &SnapshotTarget) -> Result<Plan, String> {
    match target {
        SnapshotTarget::Main => Ok(Plan::Main),
        SnapshotTarget::Display { id } => {
            let display = listing
                .displays
                .iter()
                .find(|d| d.id == *id)
                .ok_or_else(|| GONE_DISPLAY_MSG.to_string())?;
            if display.main {
                return Ok(Plan::Main);
            }
            if let Some(blocked) = display.blocked {
                return Err(blocked_message(blocked).into());
            }
            let number = display.number.ok_or_else(|| NUMBERING_MSG.to_string())?;
            Ok(Plan::Display {
                number,
                pixels: (display.pixel_width, display.pixel_height),
                points: (display.points_width, display.points_height),
            })
        }
        SnapshotTarget::Window { id } => {
            let window = listing
                .windows
                .iter()
                .find(|w| w.id == *id)
                .ok_or_else(|| GONE_WINDOW_MSG.to_string())?;
            if !window.capturable {
                return Err(PERMISSION_MSG.into());
            }
            Ok(Plan::Window { id: window.id, app: window.app.clone(), title: window.title.clone() })
        }
    }
}

fn blocked_message(blocked: Blocked) -> &'static str {
    match blocked {
        Blocked::Permission => PERMISSION_MSG,
        Blocked::Numbering => NUMBERING_MSG,
    }
}

/// Os argumentos do `screencapture` para o plano. A principal segue o comando de sempre. Pura.
pub fn capture_args(plan: &Plan, out: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = match plan {
        Plan::Main => vec!["-x".into(), "-t".into(), "png".into()],
        Plan::Display { number, .. } => {
            vec!["-x".into(), "-t".into(), "png".into(), "-D".into(), number.to_string().into()]
        }
        Plan::Window { id, .. } => {
            vec!["-x".into(), "-o".into(), "-t".into(), "png".into(), "-l".into(), id.to_string().into()]
        }
    };
    args.push(out.as_os_str().to_owned());
    args
}

/// A foto tem o tamanho esperado, em pixels ou em pontos, na vertical ou na horizontal (tela girada). Pura.
pub fn dims_match(actual: (u32, u32), expected: &[(u32, u32)]) -> bool {
    expected.iter().any(|&(w, h)| actual == (w, h) || actual == (h, w))
}

/// Os fatos da captura que vão para o JSON ao lado do PNG.
pub fn info_for(plan: &Plan, captured_at: &str) -> SnapshotInfo {
    match plan {
        Plan::Main => SnapshotInfo {
            version: SIDECAR_VERSION,
            scope: Scope::Display,
            app: None,
            title: None,
            display_number: Some(1),
            captured_at: captured_at.into(),
        },
        Plan::Display { number, .. } => SnapshotInfo {
            version: SIDECAR_VERSION,
            scope: Scope::Display,
            app: None,
            title: None,
            display_number: Some(*number),
            captured_at: captured_at.into(),
        },
        Plan::Window { app, title, .. } => SnapshotInfo {
            version: SIDECAR_VERSION,
            scope: Scope::Window,
            app: Some(app.clone()),
            title: title.clone(),
            display_number: None,
            captured_at: captured_at.into(),
        },
    }
}

pub fn info_json(info: &SnapshotInfo) -> String {
    serde_json::to_string(info).unwrap_or_default()
}

/// Lê o JSON de volta. Versão diferente, número de tela inválido ou JSON estragado viram nada. Pura.
pub fn parse_info(raw: &str) -> Option<SnapshotInfo> {
    let info: SnapshotInfo = serde_json::from_str(raw).ok()?;
    if info.version != SIDECAR_VERSION || info.display_number.is_some_and(|n| n == 0 || n > MAX_DISPLAY_NUMBER) {
        return None;
    }
    Some(SnapshotInfo {
        app: info.app.as_deref().and_then(|app| clean_text(app, MAX_APP_CHARS)),
        title: info.title.as_deref().and_then(|title| clean_text(title, MAX_TITLE_CHARS)),
        ..info
    })
}

/// O JSON ao lado de um PNG do SnapShot que está na pasta de capturas. Qualquer outro caminho não tem JSON. Pura.
pub fn sidecar_for(png: &Path, dir: &Path) -> Option<PathBuf> {
    let name = png.file_name()?.to_str()?;
    let is_snapshot = name.starts_with(PREFIX) && png.extension().is_some_and(|ext| ext == "png");
    (is_snapshot && png.parent()? == dir).then(|| png.with_extension("json"))
}

/// Lê a legenda do PNG do SnapShot: o JSON ao lado, com teto de tamanho antes de interpretar.
pub fn read_info(png: &Path, dir: &Path) -> Option<SnapshotInfo> {
    let json = sidecar_for(png, dir)?;
    let meta = std::fs::metadata(&json).ok()?;
    if !meta.is_file() || meta.len() > MAX_INFO_BYTES {
        return None;
    }
    parse_info(&std::fs::read_to_string(&json).ok()?)
}

/// `Imagens/ADE AGS` do usuário: onde o SnapShot grava. Não cria pasta nenhuma.
fn captures_dir() -> Result<PathBuf, String> {
    let base = dirs::picture_dir()
        .or_else(dirs::home_dir)
        .ok_or("Não encontrei a pasta Imagens deste usuário.")?;
    Ok(base.join("ADE AGS"))
}

/// Roda o helper Swift e lê telas e janelas. Só metadados.
#[cfg(target_os = "macos")]
fn list_native() -> Result<Listing, String> {
    let mut command = crate::util::spawn::hidden_command("/usr/bin/swift");
    command.arg("-e").arg(LIST_SWIFT);
    let output = crate::util::spawn::output(&mut command, Duration::from_secs(30))
        .map_err(|_| LIST_FAILED_MSG.to_string())?;
    if !output.status.success() {
        return Err(LIST_FAILED_MSG.into());
    }
    parse_listing(&String::from_utf8_lossy(&output.stdout))
}

/// Tamanho do PNG pelo cabeçalho (32 bytes), sem ler a foto inteira.
#[cfg(target_os = "macos")]
fn png_head_size(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut head = [0u8; 32];
    std::fs::File::open(path).ok()?.read_exact(&mut head).ok()?;
    crate::decisions::vision::png_size(&head)
}

/// Escreve o JSON ao lado do PNG. Falha não derruba a captura: a foto segue, só sem legenda.
#[cfg(target_os = "macos")]
fn write_sidecar(png: &Path, info: &SnapshotInfo) {
    let json = png.with_extension("json");
    let tmp = png.with_extension("json.tmp");
    if std::fs::write(&tmp, info_json(info)).is_err() || std::fs::rename(&tmp, &json).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn capture_error(exit_code: Option<i32>, stderr: &str, output_exists: bool) -> String {
    let diagnostic: String = stderr.trim().chars().take(500).collect();
    if diagnostic.to_lowercase().contains("could not create image from display") {
        let code = exit_code.map_or_else(|| "desconhecida".to_string(), |code| code.to_string());
        return format!(
            "O macOS não criou a captura da tela (screencapture saída {code}; stderr: {diagnostic}). O preflight de Gravação de Tela pode continuar falso mesmo com ADE AGS marcada. Confira Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema; remova ADE AGS da lista e adicione-a novamente para renovar a autorização TCC após a troca da assinatura."
        );
    }
    if !output_exists && exit_code == Some(0) {
        return "O screencapture terminou sem erro, mas não criou o arquivo PNG.".into();
    }
    let code = exit_code.map_or_else(|| "desconhecido".to_string(), |code| code.to_string());
    if diagnostic.is_empty() {
        format!("O screencapture falhou (código {code}) e não salvou a captura de tela.")
    } else {
        format!("O screencapture falhou (código {code}): {diagnostic}")
    }
}

#[cfg(test)]
mod capture_error_test {
    use super::capture_error;

    #[test]
    fn identifica_a_falha_de_tela_do_screencapture_e_preserva_o_diagnostico() {
        let error = capture_error(Some(1), "could not create image from display\n", false);
        assert!(error.contains("screencapture saída 1"));
        assert!(error.contains("could not create image from display"));
        assert!(error.contains("remova ADE AGS da lista e adicione-a novamente"));
    }

    #[test]
    fn diferencia_png_ausente_de_um_bloqueio_de_tela() {
        assert_eq!(
            capture_error(Some(0), "", false),
            "O screencapture terminou sem erro, mas não criou o arquivo PNG."
        );
        assert_eq!(
            capture_error(Some(2), "arquivo inválido", false),
            "O screencapture falhou (código 2): arquivo inválido"
        );
    }
}

/// Executa o plano: `screencapture`, conferência do tamanho e JSON ao lado. Devolve o caminho do PNG.
#[cfg(target_os = "macos")]
fn capture(plan: &Plan) -> Result<String, String> {
    let dir = captures_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Não consegui criar a pasta de capturas: {e}"))?;
    let path = dir.join(format!(
        "{PREFIX}{}_{}.png",
        chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"),
        uuid::Uuid::new_v4().simple()
    ));
    let mut command = crate::util::spawn::hidden_command("/usr/sbin/screencapture");
    command.args(capture_args(plan, &path));
    let result = crate::util::spawn::output(&mut command, Duration::from_secs(15))
        .map_err(|e| format!("Não consegui capturar a tela: {e}"))?;
    if !result.status.success() || !path.is_file() {
        let error = capture_error(
            result.status.code(),
            &String::from_utf8_lossy(&result.stderr),
            path.is_file(),
        );
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    if let Plan::Display { pixels, points, .. } = plan {
        let confere = png_head_size(&path).is_some_and(|size| dims_match(size, &[*pixels, *points]));
        if !confere {
            let _ = std::fs::remove_file(&path);
            return Err(MISMATCH_MSG.into());
        }
    }
    write_sidecar(&path, &info_for(plan, &chrono::Local::now().to_rfc3339()));
    Ok(path.to_string_lossy().into_owned())
}

/// Foto pontual: a tela principal (como antes) ou a tela ou janela escolhida no seletor do composer.
#[tauri::command(async)]
pub fn desktop_screenshot(target: Option<SnapshotTarget>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let plan = match target.unwrap_or(SnapshotTarget::Main) {
            SnapshotTarget::Main => Plan::Main,
            other => plan_for(&list_native()?, &other)?,
        };
        capture(&plan)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err(ONLY_MAC_MSG.into())
    }
}

/// Telas e janelas que o seletor mostra. Não captura nada.
#[tauri::command(async)]
pub fn snapshot_targets() -> Result<Listing, String> {
    #[cfg(target_os = "macos")]
    {
        list_native()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(ONLY_MAC_MSG.into())
    }
}

/// Legenda de cada anexo: o JSON ao lado da foto do SnapShot. Para o que não é dele, nada.
#[tauri::command(async)]
pub fn snapshot_info(paths: Vec<String>) -> Vec<Option<SnapshotInfo>> {
    let dir = captures_dir().ok();
    paths
        .iter()
        .map(|path| {
            let dir = dir.as_deref()?;
            read_info(Path::new(path), dir)
        })
        .collect()
}

#[cfg(test)]
mod test;
