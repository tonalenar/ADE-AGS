//! Quem pode falar com um servidor HTTP da ADE no loopback.
//!
//! Escutar em `127.0.0.1` não basta: qualquer página aberta no navegador do sistema alcança o
//! loopback. Três cabeçalhos dizem de onde veio o pedido, e cada um fecha um ataque:
//!
//! - `Host` precisa ser um nome de loopback com a porta deste servidor. Com DNS rebinding, o
//!   domínio do atacante passa a apontar para 127.0.0.1, mas o `Host` continua sendo o dele.
//! - `Origin`, quando vem, precisa ser deste servidor. `null` (iframe com sandbox) passa em
//!   pedido comum, nunca num WebSocket, que pode ler a resposta.
//! - `Sec-Fetch-Site: cross-site` só passa numa navegação GET/HEAD: é como a aba da app
//!   (`tauri://localhost`, outro site) abre a página no iframe. Um subrecurso cross-site
//!   (`<img>`, `<script>`) não leva `Origin` e chegaria com a sessão do projeto.
//!
//! Cabeçalho ausente passa: clientes que não são navegador (curl, o próprio Rust) e WebKits
//! antigos não mandam `Sec-Fetch-*`. A defesa contra eles é o `Host` e o `Origin`.

/// Por que um pedido foi recusado. Vai para o log; nunca para a resposta do atacante.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Host,
    Origin,
    CrossSite,
}

/// `localhost:<porta>`, `127.0.0.1:<porta>` ou `[::1]:<porta>`.
pub fn is_loopback_host(host: &str, port: u16) -> bool {
    let Some((name, p)) = host.rsplit_once(':') else { return false };
    p.parse::<u16>().ok() == Some(port) && matches!(name.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

/// `http://` mais um `Host` de loopback deste servidor.
pub fn is_loopback_origin(origin: &str, port: u16) -> bool {
    origin.strip_prefix("http://").is_some_and(|host| is_loopback_host(host, port))
}

/// Confere `Host`, `Origin` e `Sec-Fetch-Site`. `header` lê um cabeçalho pelo nome em
/// minúsculas, para servir a qualquer biblioteca HTTP.
pub fn check<'a>(
    header: impl Fn(&str) -> Option<&'a str>,
    method: &str,
    port: u16,
    websocket: bool,
) -> Result<(), Refusal> {
    if !is_loopback_host(header("host").unwrap_or(""), port) {
        return Err(Refusal::Host);
    }
    match header("origin") {
        None => {}
        Some("null") if !websocket => {}
        Some(origin) if is_loopback_origin(origin, port) => {}
        Some(_) => return Err(Refusal::Origin),
    }
    match header("sec-fetch-site").map(str::to_ascii_lowercase).as_deref() {
        Some("cross-site") => {
            let navigation = header("sec-fetch-mode").is_some_and(|m| m.eq_ignore_ascii_case("navigate"));
            let safe = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
            if !(navigation && safe && !websocket) {
                return Err(Refusal::CrossSite);
            }
        }
        // `same-origin`, `same-site` (outra porta do loopback, como o Vite da própria app em
        // desenvolvimento), `none` (a pessoa digitou o endereço) ou ausente.
        _ => {}
    }
    Ok(())
}
