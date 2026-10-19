//! A abertura do app: uma janelinha central com o robô (`splash.html`) enquanto a principal carrega
//! escondida por trás.
//!
//! A principal nasce com `visible: false` (tauri.conf.json). Visível desde o começo, ela aparecia
//! branca e no tamanho padrão, sumia ao maximizar e só depois mostrava o app. Agora o boot dela avisa
//! as etapas (`app_boot_progress`), a janelinha as mostra e, no fim (`app_boot_done`), a principal
//! aparece de uma vez, já maximizada, e a janelinha some.

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// O label da janelinha de abertura.
pub const SPLASH_LABEL: &str = "splash";
/// O evento que leva a etapa atual à janelinha.
pub const SPLASH_STEP_EVENT: &str = "ags-splash-step";
/// A etapa em que o boot está (a janelinha pode abrir depois do primeiro aviso). `SPLASH_DONE` = fim.
static STEP: AtomicU8 = AtomicU8::new(0);
pub const SPLASH_DONE: u8 = 4;
/// Se o boot nunca avisar que terminou, o app aparece assim mesmo.
pub const BOOT_FALLBACK: Duration = Duration::from_secs(20);
/// Quanto a principal tem para pintar antes de a janelinha sair da frente dela.
const HANDOFF: Duration = Duration::from_millis(150);

/// Cria a janelinha, escondida até a página dela pintar (`app_window_ready`).
pub fn open_splash(app: &AppHandle) {
    let built = splash_config(app.config().app.windows.first())
        .ok_or_else(|| "sem a janela principal em tauri.conf.json".to_string())
        .and_then(|config| {
            tauri::WebviewWindowBuilder::from_config(app, &config)
                .and_then(|builder| builder.center().build())
                .map_err(|error| error.to_string())
        });
    if let Err(error) = built {
        // Sem a janelinha o app abre igual: o fim do boot mostra a principal.
        eprintln!("[splash] não foi possível abrir a janela de abertura: {error}");
    }
}

/// A configuração da janelinha: a da principal, com outro label, página, tamanho e jeito. Parte da
/// principal porque o WebView2 de um processo é um só: uma janela com opções de navegador diferentes
/// (argumentos, pasta de dados…) falha ao nascer com 0x8007139F. Pura.
pub fn splash_config(main: Option<&tauri::utils::config::WindowConfig>) -> Option<tauri::utils::config::WindowConfig> {
    let mut config = main?.clone();
    config.label = SPLASH_LABEL.to_string();
    config.url = tauri::WebviewUrl::App("splash.html".into());
    config.title = "ADE AGS".to_string();
    config.width = 420.0;
    config.height = 440.0;
    config.min_width = None;
    config.min_height = None;
    config.maximized = false;
    config.resizable = false;
    config.maximizable = false;
    config.decorations = false;
    config.transparent = true;
    config.shadow = false;
    config.center = true;
    // Por cima até o app aparecer: sem isso, qualquer janela que ganhe o foco nesse meio a esconde.
    config.always_on_top = true;
    config.visible = false;
    config.create = false;
    Some(config)
}

/// Mostra uma janela que ainda está escondida. A principal aparece maximizada (o app sempre abre em tela
/// cheia); a janelinha, do tamanho dela. Numa janela visível não faz nada.
pub fn reveal(window: &WebviewWindow) {
    if window.is_visible().unwrap_or(true) {
        return;
    }
    if window.label() == "main" {
        let _ = window.maximize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// A página da janelinha já pintou: ela pode aparecer.
#[tauri::command]
pub fn app_window_ready(window: WebviewWindow) {
    reveal(&window);
}

/// A etapa do boot da janela principal. A janelinha a recebe por evento.
#[tauri::command]
pub fn app_boot_progress(app: AppHandle, step: u8) {
    let step = step.min(SPLASH_DONE);
    // Nunca volta atrás: uma janela que recarrega não reabre etapas já feitas.
    let previous = STEP.fetch_max(step, Ordering::SeqCst);
    if step > previous {
        let _ = app.emit_to(SPLASH_LABEL, SPLASH_STEP_EVENT, step);
    }
}

/// A etapa atual, para a janelinha que abriu depois de avisos já enviados.
#[tauri::command]
pub fn app_boot_step() -> u8 {
    STEP.load(Ordering::SeqCst)
}

/// O boot terminou: a principal aparece e a janelinha sai.
#[tauri::command]
pub fn app_boot_done(app: AppHandle) {
    finish(&app);
}

/// Mostra a principal e, um instante depois, fecha a janelinha (por cima da principal que já pinta).
/// Idempotente: chamado de novo, ou pela rede, não faz nada a mais.
pub fn finish(app: &AppHandle) {
    STEP.store(SPLASH_DONE, Ordering::SeqCst);
    if let Some(main) = app.get_webview_window("main") {
        reveal(&main);
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HANDOFF);
        // `destroy` e não `close`: o fechamento normal passa pelo "salvar antes de fechar" das janelas
        // do app, e a janelinha não tem o que salvar.
        if let Some(splash) = handle.get_webview_window(SPLASH_LABEL) {
            let _ = splash.destroy();
        }
    });
}

/// A rede: se o boot nunca terminar, o app aparece assim mesmo.
pub fn arm_fallback(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(BOOT_FALLBACK);
        let main_hidden = handle
            .get_webview_window("main")
            .is_some_and(|main| !main.is_visible().unwrap_or(true));
        if main_hidden {
            finish(&handle);
        }
    });
}
