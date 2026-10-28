//! Cliente HTTP único para a Laya local, a Laya Studio e o Jev.
//!
//! Só mudam a URL base e a chave. Os caminhos quentes (Vigia, roteamento, memória) não repetem: um timeout já é a
//! resposta. O piloto do navegador, que é interativo e perde o `act` inteiro quando uma consulta falha, usa
//! `RetryPolicy::Patient`: repete com espera crescente em 429/502/503/504/529 (como o `post_json` do jev-ultrafast), em
//! falha de conexão e uma vez em timeout, com o tempo limite adaptado às últimas latências (plano v2, 4.3, achado D5).
//! Toda chamada devolve também `CallStats` (tentativas, bytes de ida e volta, espera): é de onde vem a medição por
//! consulta (4.2, achado D2).

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};

use super::config::{ProviderKind, Settings};
use super::protocol::{DecisionError, DecisionRequest, DecisionResponse, parse_response};
use super::shadow::redact;

/// Quantas vezes o piloto repete uma consulta que falhou por motivo passageiro.
const MAX_RETRIES: u32 = 3;
/// A primeira espera; dobra a cada repetição (250, 500, 1000 ms).
const BACKOFF_BASE_MS: u64 = 250;
/// O `Retry-After` do provedor vale, mas um teto: o piloto não fica parado por ele.
const RETRY_AFTER_CAP_MS: u64 = 2_000;
/// O piloto desiste de repetir depois disto, somando tempo de rede e esperas.
const RETRY_DEADLINE: Duration = Duration::from_secs(10);
/// Sem latências medidas ainda (a primeira consulta, a conexão ainda fria), o limite do piloto não fica abaixo disto.
const COLD_FLOOR_MS: u64 = 3_000;
/// O teto do limite adaptativo: acima disto o `act` inteiro já estaria perdido.
const ADAPTIVE_CAP_MS: u64 = 12_000;
/// Quantas latências recentes (bem-sucedidas) guardar por servidor.
const WINDOW: usize = 32;
/// Com menos que isto não há p95 que valha.
const MIN_SAMPLES: usize = 5;

pub struct SystemOneHttpProvider {
    pub base_url: String,
    pub api_key: Option<String>,
    pub timeout: Duration,
    pub model: String,
    pub provider: ProviderKind,
}

/// Se uma consulta que falhou é repetida.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryPolicy {
    /// Uma tentativa só (Vigia, roteamento, memória: lá um timeout já é a resposta).
    Off,
    /// O piloto: repete com espera crescente e adapta o tempo limite.
    Patient,
}

/// O que uma chamada custou, para medir (e para explicar um erro).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallStats {
    pub attempts: u32,
    /// O corpo do pedido (JSON) em bytes.
    pub bytes_out: usize,
    /// O corpo da resposta em bytes (0 se não chegou).
    pub bytes_in: usize,
    /// Quanto se esperou entre tentativas.
    pub backoff_ms: u64,
    /// O tempo limite da última tentativa.
    pub timeout_ms: u64,
}

/// Uma tentativa que falhou, com o que decide se vale repetir.
struct Failure {
    error: DecisionError,
    retry_after: Option<Duration>,
    /// A conexão nem chegou a abrir (recusada, sem rota): nada foi enviado, repetir é seguro.
    connect: bool,
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
        self.decide_with(request, RetryPolicy::Off).0
    }

    pub fn decide_with(
        &self,
        request: &DecisionRequest,
        policy: RetryPolicy,
    ) -> (Result<DecisionResponse, DecisionError>, CallStats) {
        let mut stats = CallStats::default();
        let result = self.run(request, policy, &mut stats);
        (result, stats)
    }

    fn run(
        &self,
        request: &DecisionRequest,
        policy: RetryPolicy,
        stats: &mut CallStats,
    ) -> Result<DecisionResponse, DecisionError> {
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
        // Serializado uma vez: o mesmo corpo serve a todas as tentativas, e o tamanho é o que se mede.
        let payload = serde_json::to_vec(&body)
            .map_err(|error| DecisionError::Malformed(clip(&error.to_string())))?;
        stats.bytes_out = payload.len();
        let url = endpoint(&self.base_url);
        let client = client()?;
        let started = Instant::now();
        let mut timeout = match policy {
            RetryPolicy::Off => self.timeout,
            RetryPolicy::Patient => adaptive_timeout(self.timeout, &recent_latencies(&self.base_url)),
        };
        loop {
            stats.attempts += 1;
            stats.timeout_ms = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
            let attempt_started = Instant::now();
            match self.once(client, &url, &payload, timeout, stats) {
                Ok(response) => {
                    note_latency(&self.base_url, attempt_started.elapsed());
                    return Ok(response);
                }
                Err(failure) => {
                    let retry = policy == RetryPolicy::Patient
                        && stats.attempts <= MAX_RETRIES
                        && started.elapsed() < RETRY_DEADLINE
                        && retryable(&failure, stats.attempts);
                    if !retry {
                        return Err(failure.error);
                    }
                    let wait = backoff(stats.attempts, failure.retry_after);
                    stats.backoff_ms += u64::try_from(wait.as_millis()).unwrap_or(u64::MAX);
                    std::thread::sleep(wait);
                    // Um timeout repetido com o mesmo prazo falharia igual: a segunda tentativa ganha o dobro.
                    if matches!(failure.error, DecisionError::Timeout) {
                        timeout = (timeout * 2).min(Duration::from_millis(ADAPTIVE_CAP_MS).max(self.timeout));
                    }
                }
            }
        }
    }

    fn once(
        &self,
        client: &Client,
        url: &str,
        payload: &[u8],
        timeout: Duration,
        stats: &mut CallStats,
    ) -> Result<DecisionResponse, Failure> {
        let secret = self.api_key.as_deref();
        let mut call = client
            .post(url)
            .timeout(timeout)
            .header(CONTENT_TYPE, "application/json")
            .body(payload.to_vec());
        if let Some(key) = secret.filter(|key| !key.is_empty()) {
            call = call.header(AUTHORIZATION, format!("Bearer {key}"));
        }
        let transport = |error: reqwest::Error| Failure {
            connect: error.is_connect() && !error.is_timeout(),
            retry_after: None,
            error: map_transport(error, secret),
        };
        let response = call.send().map_err(transport)?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let text = response.text().map_err(transport)?;
        stats.bytes_in = text.len();
        let text = redact(&text, secret);
        let fail = |error: DecisionError| Failure { error, retry_after, connect: false };
        match status.as_u16() {
            200 => parse_response(&text).map_err(|error| {
                fail(match error {
                    DecisionError::Malformed(message) => DecisionError::Malformed(redact(&message, secret)),
                    other => other,
                })
            }),
            // 401 fica só o código: o corpo de autenticação não diz como corrigir o pedido.
            401 => Err(fail(DecisionError::Unauthorized)),
            code => {
                let message = if (400..500).contains(&code) {
                    super::protocol::client_error_message(&text)
                } else {
                    String::new()
                };
                Err(fail(if code == 422 {
                    DecisionError::Unprocessable(message)
                } else {
                    DecisionError::Status { code, message }
                }))
            }
        }
    }
}

/// Um motivo passageiro: o provedor sobrecarregado (429/502/503/504/529), a conexão que não abriu, ou o primeiro timeout.
fn retryable(failure: &Failure, attempts: u32) -> bool {
    match &failure.error {
        DecisionError::Status { code, .. } => matches!(code, 429 | 502 | 503 | 504 | 529),
        DecisionError::Timeout => attempts == 1,
        DecisionError::Transport(_) => failure.connect,
        _ => false,
    }
}

/// Quanto esperar antes da repetição de número `attempt` (1 = depois da primeira falha): 250, 500, 1000 ms, ou o
/// `Retry-After` do provedor (no máximo 2 s) se for maior. Pura.
pub(super) fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let exponential = Duration::from_millis(BACKOFF_BASE_MS << attempt.saturating_sub(1).min(6));
    match retry_after {
        Some(asked) => exponential.max(asked.min(Duration::from_millis(RETRY_AFTER_CAP_MS))),
        None => exponential,
    }
}

/// O tempo limite do piloto: nunca abaixo do configurado; com latências medidas, 3× o p95 + 400 ms; sem elas (a conexão
/// ainda fria), pelo menos 3 s; nunca acima de 12 s (a menos que o configurado já seja maior). Pura.
pub(super) fn adaptive_timeout(configured: Duration, samples_ms: &[u64]) -> Duration {
    let wanted = if samples_ms.len() < MIN_SAMPLES {
        COLD_FLOOR_MS
    } else {
        let mut sorted = samples_ms.to_vec();
        sorted.sort_unstable();
        let rank = (sorted.len() * 95).div_ceil(100).max(1) - 1;
        (3 * sorted[rank] + 400).max(1)
    };
    configured.max(Duration::from_millis(wanted.min(ADAPTIVE_CAP_MS)))
}

fn latencies() -> &'static Mutex<HashMap<String, VecDeque<u64>>> {
    static LATENCIES: OnceLock<Mutex<HashMap<String, VecDeque<u64>>>> = OnceLock::new();
    LATENCIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn note_latency(base_url: &str, elapsed: Duration) {
    let Ok(mut map) = latencies().lock() else { return };
    let window = map.entry(base_url.to_string()).or_default();
    if window.len() >= WINDOW {
        window.pop_front();
    }
    window.push_back(u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX));
}

fn recent_latencies(base_url: &str) -> Vec<u64> {
    latencies()
        .lock()
        .ok()
        .and_then(|map| map.get(base_url).map(|window| window.iter().copied().collect()))
        .unwrap_or_default()
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

/// Um cliente só para todas as consultas: cada `Client::build` abria uma conexão TLS nova (cerca de 200 ms a
/// mais por decisão). O prazo vale por pedido (`.timeout`), então não prende o cliente a um valor. Com HTTP/2 uma
/// conexão leva todas as consultas (a ALPN escolhe `h2` quando o servidor oferece), e o `ping` a mantém viva entre
/// um `act` e outro.
pub(super) fn client() -> Result<&'static Client, DecisionError> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(300))
        .tcp_keepalive(Duration::from_secs(30))
        .tcp_nodelay(true)
        .http2_adaptive_window(true)
        .build()
        .map_err(|error| DecisionError::Transport(error.to_string()))?;
    Ok(CLIENT.get_or_init(|| built))
}

/// Abre a conexão com o Jev antes da primeira consulta (TCP + TLS + HTTP/2, ~200 ms que o primeiro passo do `act`
/// pagava). Só quando o piloto está ligado: é o único ponto que justifica falar com o provedor sem ter o que
/// perguntar, e não leva nada além de um `HEAD` na raiz. Em segundo plano; falha em silêncio. No máximo uma a cada 20 s.
pub fn preconnect(settings: &Settings) {
    static LAST: AtomicU64 = AtomicU64::new(0);
    if !settings.active()
        || !settings.allows(super::points::POINT_BROWSE)
        || !matches!(settings.provider, ProviderKind::Jev | ProviderKind::LayaStudio)
    {
        return;
    }
    let now = crate::util::now_ts().max(0) as u64;
    let last = LAST.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 20 {
        return;
    }
    LAST.store(now, Ordering::Relaxed);
    let base = settings.base_url.trim_end_matches('/').to_string();
    std::thread::spawn(move || {
        if let Ok(client) = client() {
            let _ = client.head(base).timeout(Duration::from_secs(5)).send();
        }
    });
}

pub(super) fn endpoint(base_url: &str) -> String {
    format!("{}/v1/systemone", base_url.trim_end_matches('/'))
}

pub(super) fn map_transport(error: reqwest::Error, secret: Option<&str>) -> DecisionError {
    // Estourar ao CONECTAR é a rede (nada chegou ao provedor); estourar esperando a resposta, com a conexão aberta, é ele.
    if error.is_timeout() && !error.is_connect() {
        DecisionError::Timeout
    } else if error.is_timeout() {
        DecisionError::Transport("tempo esgotado ao conectar".into())
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
    execute_with(settings, api_key, request, RetryPolicy::Off).0
}

/// Como `execute`, com a política de repetição escolhida e o que a chamada custou.
pub fn execute_with(
    settings: &Settings,
    api_key: Option<&str>,
    request: &DecisionRequest,
    policy: RetryPolicy,
) -> (Result<DecisionResponse, DecisionError>, CallStats) {
    match settings.provider {
        ProviderKind::None => (
            Err(DecisionError::Unavailable("provedor desligado".into())),
            CallStats::default(),
        ),
        ProviderKind::Clef => (
            Err(DecisionError::Unavailable("Cloudflare Clef ainda não tem cliente".into())),
            CallStats::default(),
        ),
        ProviderKind::LayaLocal | ProviderKind::LayaStudio | ProviderKind::Jev => {
            SystemOneHttpProvider::from_settings(settings, api_key.map(str::to_string))
                .decide_with(request, policy)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;
    use crate::decisions::protocol::Question;

    const OK: &str = r#"{"model":"jev","answers":{"operacao":{"type":"choice","choice":"click","probabilities":{"click":0.9,"done":0.1},"confidence":0.9}},"usage":{"input_tokens":120,"output_tokens":4}}"#;

    /// Um servidor que responde cada conexão com a próxima resposta da lista (status, cabeçalho extra, corpo).
    fn serve_sequence(replies: Vec<(u16, &'static str, &'static str)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for (status, extra, body) in replies {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 16_384];
                let _ = stream.read(&mut buf);
                let header = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        format!("http://{address}")
    }

    fn provider(url: &str, timeout_ms: u64) -> SystemOneHttpProvider {
        SystemOneHttpProvider {
            base_url: url.into(),
            api_key: Some("chave-secreta-xyz".into()),
            timeout: Duration::from_millis(timeout_ms),
            model: "jev-latest".into(),
            provider: ProviderKind::Jev,
        }
    }

    fn request() -> DecisionRequest {
        let mut questions = std::collections::BTreeMap::new();
        questions.insert("operacao".into(), Question::choice("próxima?", &[("click", "tocar"), ("done", "pronto")]));
        DecisionRequest { state: "GOAL: x".into(), questions, model: String::new(), heuristic: Default::default() }
    }

    #[test]
    fn a_espera_cresce_e_o_retry_after_vale_ate_o_teto() {
        assert_eq!(backoff(1, None), Duration::from_millis(250));
        assert_eq!(backoff(2, None), Duration::from_millis(500));
        assert_eq!(backoff(3, None), Duration::from_millis(1000));
        assert_eq!(backoff(1, Some(Duration::from_secs(1))), Duration::from_secs(1));
        assert_eq!(backoff(1, Some(Duration::from_secs(60))), Duration::from_millis(RETRY_AFTER_CAP_MS));
        assert_eq!(backoff(2, Some(Duration::from_millis(100))), Duration::from_millis(500), "o maior dos dois");
    }

    #[test]
    fn o_limite_adaptativo_nunca_cai_abaixo_do_configurado_nem_passa_do_teto() {
        let configured = Duration::from_millis(800);
        // Sem amostras: o piso frio, para a conexão ainda sem handshake.
        assert_eq!(adaptive_timeout(configured, &[]), Duration::from_millis(COLD_FLOOR_MS));
        assert_eq!(adaptive_timeout(configured, &[300, 400]), Duration::from_millis(COLD_FLOOR_MS), "poucas amostras");
        // 3× o p95 + 400: com p95 de 500 ms, 1.900 ms; mas nunca abaixo do configurado.
        let steady = [400, 420, 450, 460, 480, 500];
        assert_eq!(adaptive_timeout(configured, &steady), Duration::from_millis(1_900));
        assert_eq!(adaptive_timeout(Duration::from_millis(5_000), &steady), Duration::from_millis(5_000));
        // Latências ruins: o teto.
        assert_eq!(adaptive_timeout(configured, &[9_000; 8]), Duration::from_millis(ADAPTIVE_CAP_MS));
        // Configurado maior que o teto vale (é escolha do usuário).
        assert_eq!(adaptive_timeout(Duration::from_secs(20), &[9_000; 8]), Duration::from_secs(20));
    }

    #[test]
    fn sobrecarga_do_provedor_e_repetida_ate_dar_certo() {
        let url = serve_sequence(vec![(503, "Retry-After: 0\r\n", "{}"), (529, "", "{}"), (200, "", OK)]);
        let (result, stats) = provider(&url, 1_000).decide_with(&request(), RetryPolicy::Patient);
        let response = result.expect("a terceira tentativa responde");
        assert_eq!(response.answers["operacao"].label, "click");
        assert_eq!(stats.attempts, 3);
        assert!(stats.backoff_ms >= 750, "250 + 500 ms de espera: {}", stats.backoff_ms);
        assert!(stats.bytes_out > 0 && stats.bytes_in > 0, "{stats:?}");
    }

    #[test]
    fn sem_a_politica_paciente_uma_falha_e_a_resposta() {
        let url = serve_sequence(vec![(503, "", "{}"), (200, "", OK)]);
        let (result, stats) = provider(&url, 1_000).decide_with(&request(), RetryPolicy::Off);
        assert!(matches!(result, Err(DecisionError::Status { code: 503, .. })));
        assert_eq!(stats.attempts, 1);
    }

    #[test]
    fn erro_que_nao_e_passageiro_nao_e_repetido() {
        let url = serve_sequence(vec![(401, "", "{}"), (200, "", OK)]);
        let (result, stats) = provider(&url, 1_000).decide_with(&request(), RetryPolicy::Patient);
        assert!(matches!(result, Err(DecisionError::Unauthorized)));
        assert_eq!(stats.attempts, 1, "uma chave recusada não melhora repetindo");
    }

    #[test]
    fn desiste_depois_do_teto_de_repeticoes_e_diz_quantas_tentativas_foram() {
        let url = serve_sequence(vec![(503, "", "{}"); 5]);
        let (result, stats) = provider(&url, 1_000).decide_with(&request(), RetryPolicy::Patient);
        assert!(matches!(result, Err(DecisionError::Status { code: 503, .. })));
        assert_eq!(stats.attempts, MAX_RETRIES + 1);
    }

    #[test]
    fn a_conexao_recusada_e_repetida_e_conta_como_rede() {
        // Uma porta em que ninguém escuta: a conexão é recusada, nada foi enviado.
        let port = { TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
        let (result, stats) = provider(&format!("http://127.0.0.1:{port}"), 500).decide_with(&request(), RetryPolicy::Patient);
        let error = result.unwrap_err();
        assert!(matches!(error, DecisionError::Transport(_)), "{error}");
        assert_eq!(error.fault(), crate::decisions::protocol::Fault::Network);
        assert_eq!(stats.attempts, MAX_RETRIES + 1);
    }

    #[test]
    fn o_erro_diz_se_foi_a_rede_ou_o_provedor() {
        use crate::decisions::protocol::Fault;
        let rede = DecisionError::Transport("tempo esgotado ao conectar".into());
        assert_eq!(rede.fault(), Fault::Network);
        assert!(rede.explain(4, 3000).contains("REDE"), "{}", rede.explain(4, 3000));
        assert!(rede.explain(4, 3000).contains("depois de 4 tentativas"));

        let lento = DecisionError::Timeout;
        assert_eq!(lento.fault(), Fault::Provider);
        let texto = lento.explain(1, 3000);
        assert!(texto.contains("PROVEDOR") && texto.contains("3000 ms") && !texto.contains("tentativas"), "{texto}");

        for code in [429u16, 503, 529] {
            let error = DecisionError::Status { code, message: String::new() };
            assert_eq!(error.fault(), Fault::Provider, "{code}");
            assert!(error.explain(4, 3000).contains("PROVEDOR"), "{code}");
        }
        assert_eq!(DecisionError::Unauthorized.fault(), Fault::Local);
        assert!(DecisionError::Unauthorized.explain(1, 0).contains("chave"));
        // O código continua na frase, para quem procura.
        assert!(DecisionError::Timeout.explain(1, 800).contains("(timeout)"));
    }

    /// Um `HEAD` na raiz do Jev (sem corpo, sem chave): que versão do HTTP a ALPN escolhe, e quanto custa a primeira e a segunda
    /// conexão (a segunda reaproveita a primeira). `cargo test sonda_versao_http -- --ignored --nocapture`.
    #[test]
    #[ignore = "usa a rede"]
    fn sonda_versao_http() {
        let client = client().unwrap();
        for round in 1..=3 {
            let started = Instant::now();
            let response = client.head("https://api.typesafe.ai/").timeout(Duration::from_secs(8)).send();
            match response {
                Ok(r) => eprintln!("HEAD {round}: {:?} http {} em {} ms", r.version(), r.status(), started.elapsed().as_millis()),
                Err(e) => eprintln!("HEAD {round}: falhou em {} ms: {e}", started.elapsed().as_millis()),
            }
        }
    }

    #[test]
    fn a_chave_nunca_aparece_no_erro() {
        let url = serve_sequence(vec![(422, "", "{\"error\":\"chave-secreta-xyz\"}")]);
        let (result, _) = provider(&url, 1_000).decide_with(&request(), RetryPolicy::Patient);
        assert!(!result.unwrap_err().code().contains("chave-secreta-xyz"));
    }
}
