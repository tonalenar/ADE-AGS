use std::path::{Path, PathBuf};

pub(crate) struct WipeString(pub(crate) String);

impl Drop for WipeString {
    fn drop(&mut self) {
        // SAFETY: bytes zero formam UTF-8 válido e removem a cópia em memória do segredo.
        unsafe {
            self.0.as_mut_vec().fill(0);
        }
        self.0.clear();
    }
}

pub fn askpass_entry() -> Option<i32> {
    None
}

pub(crate) struct EphemeralAskpass;

impl EphemeralAskpass {
    pub(crate) fn start(_expected_host: &str, _git_user: &str, _token: &str) -> Result<Self, String> {
        Err("não implementado".into())
    }

    pub(crate) fn env_vars(&self, _helper_exe: &Path) -> Vec<(String, String)> {
        Vec::new()
    }

    #[cfg(test)]
    pub(crate) fn addr(&self) -> std::net::SocketAddr {
        "127.0.0.1:0".parse().unwrap()
    }

    #[cfg(test)]
    pub(crate) fn nonce(&self) -> &str {
        ""
    }
}

pub(crate) fn prompt_matches_host(_prompt: &str, _expected_host: &str) -> Option<&'static str> {
    None
}

pub(crate) fn fetch_credential_over_loopback(
    _addr: &str,
    _nonce: &str,
    _prompt: &str,
    _expected_host: &str,
) -> Result<WipeString, String> {
    Err("não implementado".into())
}

pub(crate) fn helper_program(_app: Option<&tauri::AppHandle>) -> Result<PathBuf, String> {
    Err("não implementado".into())
}

pub(crate) fn sanitize_error(text: &str, _secrets: &[&str]) -> String {
    text.to_string()
}
