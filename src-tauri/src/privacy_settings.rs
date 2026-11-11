//! Abertura dos painéis de privacidade do macOS usados pela ADE.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyPane {
    ScreenCapture,
    Microphone,
    SpeechRecognition,
}

impl PrivacyPane {
    #[cfg(any(target_os = "macos", test))]
    fn key(self) -> &'static str {
        match self {
            Self::ScreenCapture => "ScreenCapture",
            Self::Microphone => "Microphone",
            Self::SpeechRecognition => "SpeechRecognition",
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn settings_url(pane: PrivacyPane) -> String {
    format!(
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_{}",
        pane.key()
    )
}

/// Abre somente painéis de privacidade que a ADE usa. O nome do painel nunca vem livre do frontend.
#[tauri::command]
pub fn open_privacy_settings(pane: PrivacyPane) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::time::Duration;

        let url = settings_url(pane);
        let mut command = crate::util::spawn::hidden_command("/usr/bin/open");
        command.arg(&url);
        let output = crate::util::spawn::output(&mut command, Duration::from_secs(10))
            .map_err(|error| format!("Não consegui abrir os Ajustes do Sistema: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if detail.is_empty() {
                "O macOS recusou abrir o painel de privacidade.".into()
            } else {
                format!("O macOS recusou abrir o painel de privacidade: {detail}")
            })
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Err("A abertura de Ajustes de privacidade está disponível no macOS.".into())
    }
}

#[cfg(test)]
mod test {
    use super::{settings_url, PrivacyPane};

    #[test]
    fn aceita_somente_os_paineis_de_privacidade_usados_pelo_app() {
        for (value, pane, url) in [
            (
                "screen_capture",
                PrivacyPane::ScreenCapture,
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
            ),
            (
                "microphone",
                PrivacyPane::Microphone,
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
            ),
            (
                "speech_recognition",
                PrivacyPane::SpeechRecognition,
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_SpeechRecognition",
            ),
        ] {
            let parsed: PrivacyPane = serde_json::from_str(&format!("\"{value}\"")).unwrap();
            assert_eq!(parsed, pane);
            assert_eq!(settings_url(parsed), url);
        }
        assert!(serde_json::from_str::<PrivacyPane>("\"full_disk_access\"").is_err());
    }
}
