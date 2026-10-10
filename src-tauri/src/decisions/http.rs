//! Cliente HTTP único para a Laya local, a Laya Studio e o Jev.
//!
//! Só mudam a URL base e a chave. Sem retry: no caminho quente um timeout já é a resposta.

use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};

use super::config::{ProviderKind, Settings};
use super::protocol::{DecisionError, DecisionRequest, DecisionResponse, parse_response};
use super::shadow::redact;

pub struct SystemOneHttpProvider {
    pub base_url: String,
    pub api_key: Option<String>,
    pub timeout: Duration,
    pub model: String,
    pub provider: ProviderKind,
}

impl SystemOneHttpProvider {
    pub fn from_settings(settings: &Settings, api_key: Option<String>) -> Self {
        Self {
            base_url: settings.base_url.clone(),
            api_key,
            timeout: Duration::from_millis(settings.timeout_ms),
            model: settings.provider.coerce_model(&settings.model),
            provider: settings.provider,
        }
    }

    pub fn decide(&self, request: &DecisionRequest) -> Result<DecisionResponse, DecisionError> {
        let mut request = request.clone();
        let candidate = if request.model.trim().is_empty() {
            self.model.as_str()
        } else {
            request.model.as_str()
        };
        request.model = self.provider.coerce_model(candidate);
        // A Laya passa por `wire` (o corte de ~1.024 tokens). O Jev usa o teto maior.
        let budget = self.provider.state_char_budget();
        let body = if budget == super::protocol::STATE_CHAR_BUDGET {
            request.wire()?
        } else {
            request.wire_with_budget(budget)?
        };
        let url = endpoint(&self.base_url);
        let client = client(self.timeout)?;
        let mut call = client
            .post(url)
            .header(CONTENT_TYPE, "application/json")
            .json(&body);
        if let Some(key) = self.api_key.as_deref().filter(|key| !key.is_empty()) {
            call = call.header(AUTHORIZATION, format!("Bearer {key}"));
        }
        let response = call
            .send()
            .map_err(|error| map_transport(error, self.api_key.as_deref()))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|error| map_transport(error, self.api_key.as_deref()))?;
        let text = redact(&text, self.api_key.as_deref());
        match status.as_u16() {
            200 => parse_response(&text).map_err(|error| match error {
                DecisionError::Malformed(message) => {
                    DecisionError::Malformed(redact(&message, self.api_key.as_deref()))
                }
                other => other,
            }),
            // 401 fica só o código: o corpo de autenticação não diz como corrigir o pedido.
            401 => Err(DecisionError::Unauthorized),
            code => {
                let message = if (400..500).contains(&code) {
                    super::protocol::client_error_message(&text)
                } else {
                    String::new()
                };
                if code == 422 {
                    Err(DecisionError::Unprocessable(message))
                } else {
                    Err(DecisionError::Status { code, message })
                }
            }
        }
    }
}

pub trait DecisionProvider {
    fn decide(&self, request: &DecisionRequest) -> Result<DecisionResponse, DecisionError>;
}

impl DecisionProvider for SystemOneHttpProvider {
    fn decide(&self, request: &DecisionRequest) -> Result<DecisionResponse, DecisionError> {
        SystemOneHttpProvider::decide(self, request)
    }
}

/// A heurística atual, no mesmo formato da resposta do provedor, para comparar.
pub struct HeuristicProvider;

impl DecisionProvider for HeuristicProvider {
    fn decide(&self, request: &DecisionRequest) -> Result<DecisionResponse, DecisionError> {
        if request.heuristic.is_empty() {
            return Err(DecisionError::Malformed("heurística vazia".into()));
        }
        let answers = request
            .heuristic
            .iter()
            .map(|(id, label)| {
                (
                    id.clone(),
                    super::protocol::DecisionAnswer {
                        label: label.clone(),
                        probability: None,
                        confidence: None,
                    },
                )
            })
            .collect();
        Ok(DecisionResponse {
            answers,
            input_tokens: 0,
            output_tokens: 0,
            model: "heuristic".into(),
        })
    }
}

fn client(timeout: Duration) -> Result<Client, DecisionError> {
    Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
        .map_err(|error| DecisionError::Transport(error.to_string()))
}

fn endpoint(base_url: &str) -> String {
    format!("{}/v1/systemone", base_url.trim_end_matches('/'))
}

fn map_transport(error: reqwest::Error, secret: Option<&str>) -> DecisionError {
    if error.is_timeout() {
        DecisionError::Timeout
    } else {
        DecisionError::Transport(clip(&redact(&error.to_string(), secret)))
    }
}

fn clip(text: &str) -> String {
    super::protocol::truncate_chars(text, 300)
}

pub fn execute(
    settings: &Settings,
    api_key: Option<&str>,
    request: &DecisionRequest,
) -> Result<DecisionResponse, DecisionError> {
    match settings.provider {
        ProviderKind::None => Err(DecisionError::Unavailable("provedor desligado".into())),
        ProviderKind::Clef => Err(DecisionError::Unavailable(
            "Cloudflare Clef ainda não tem cliente".into(),
        )),
        ProviderKind::LayaLocal | ProviderKind::LayaStudio | ProviderKind::Jev => {
            SystemOneHttpProvider::from_settings(settings, api_key.map(str::to_string))
                .decide(request)
        }
    }
}
