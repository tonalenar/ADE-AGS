//! O que NÃO atravessa para outro agente ou outra conta quando a conversa vira contexto portátil (`handoff`, `fork_portatil`).
//!
//! O T3 Code não leva ao agente novo o raciocínio, o estado das ferramentas nem anexos; a ADE faz o mesmo e, além disso,
//! esconde o que parece segredo no texto que leva (mensagens, comandos) e não nomeia arquivos sensíveis. Nenhum valor
//! vem do ambiente do processo: o contexto sai só do que a conversa gravou. É uma rede de segurança, não uma garantia:
//! o texto continua sendo DADO e a pessoa decide o que digita.
//!
//! Puro: sem banco, sem relógio, sem processo.

use std::sync::OnceLock;

use regex::Regex;

/// O que aparece no lugar de um segredo.
pub const HIDDEN: &str = "[oculto]";

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let rules: [(&str, &str); 6] = [
            // Chave privada inteira (PEM), em várias linhas.
            (r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", "[chave privada oculta]"),
            // Cabeçalho de autorização.
            (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", "$1 [oculto]"),
            // Tokens com prefixo conhecido (OpenAI/Anthropic, GitHub, Slack, AWS, Google, JWT).
            (
                r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})",
                HIDDEN,
            ),
            // Usuário e senha dentro de uma URL.
            (r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@", "${1}[oculto]@"),
            // `NOME_DO_SEGREDO=valor` / `senha: valor` (o valor entre aspas ou até o próximo espaço).
            (
                r#"(?i)\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|senha|api[_-]?key|private[_-]?key|credential|authorization|client[_-]?secret)[A-Za-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)"#,
                "$1=[oculto]",
            ),
            // O mesmo no estilo de flag de linha de comando: `--token valor`.
            (r"(?i)(--?(?:token|password|passwd|api[_-]?key|secret|auth[_-]?token))[ =]+[^\s-][^\s]*", "$1 [oculto]"),
        ];
        rules.iter().filter_map(|(pattern, with)| Regex::new(pattern).ok().map(|re| (re, *with))).collect()
    })
}

/// O texto sem o que parece segredo. Mantém quebras de linha e o resto do texto. Pura.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for (re, with) in patterns() {
        if re.is_match(&out) {
            out = re.replace_all(&out, *with).into_owned();
        }
    }
    // O que os padrões não pegaram mas o detector do app ainda vê (um token longo e sem prefixo, uma URL com senha): a
    // linha toda sai. É o detector que olha o VALOR da atribuição (o rígido apagaria qualquer `senha: ...`), e o que já
    // foi escondido (`senha=[oculto]`) entra nele como `…`, para não apagar a linha inteira à toa.
    out.split('\n')
        .map(|line| if crate::memory::agent::looks_like_user_secret(&line.replace(HIDDEN, "…")) { "[linha oculta: parece conter um segredo]" } else { line })
        .collect::<Vec<_>>()
        .join("\n")
}

/// O caminho é de um arquivo que costuma guardar segredo (`.env`, chaves, credenciais)? Esses nomes não vão no contexto.
/// Pura.
pub fn sensitive_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let name = normalized.rsplit('/').next().unwrap_or("");
    if name == ".env" || name.starts_with(".env.") || name.ends_with(".env") {
        return !name.ends_with(".example") && !name.ends_with(".sample") && !name.ends_with(".template");
    }
    const NAMES: [&str; 9] = [".npmrc", ".netrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "credentials", "credentials.json", "secrets.json"];
    if NAMES.contains(&name) || name.starts_with("id_rsa") {
        return true;
    }
    const EXTENSIONS: [&str; 6] = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];
    EXTENSIONS.iter().any(|ext| name.ends_with(ext)) || normalized.contains("/.ssh/") || normalized.contains("/.aws/") || normalized.contains("/.gnupg/")
}
