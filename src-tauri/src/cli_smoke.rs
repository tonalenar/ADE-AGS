//! `ags test smoke`: o roteiro fixo do CLI contra o app aberto.
//!
//! Antes, o agente de Backend de uma missão de teste improvisava umas 24 chamadas para exercitar o
//! CLI, e cada uma custava um turno do modelo. Aqui é um comando só, com asserções, em segundos.
//!
//! Os passos que o app só aceita DE DENTRO de um terminal (`peers`, `memory`, `peer tell`) são
//! "pulados" fora dele, nunca falha: fora do terminal a recusa é o comportamento certo.
//!
//! O envio de `peer tell --file` vai a um destino que não existe: prova que o arquivo foi lido e
//! chegou ao app como `text`, sem entregar mensagem a ninguém (nem esperar confirmação de ninguém).

use super::*;

pub(crate) enum Outcome {
    Pass(String),
    Skip(String),
    Fail(String),
}

pub(crate) struct Check {
    pub name: &'static str,
    pub outcome: Outcome,
    pub ms: u128,
}

/// O texto do probe: aspas duplas e simples, acento, `$HOME` e crase, em duas linhas.
const PROBE: &str = "Smoke do CLI: \"aspas duplas\", 'aspas simples', ação, literal $HOME e `crase`.\nSegunda linha.";

/// Recusa que o app dá a um comando que só vale dentro de um terminal dele.
fn needs_terminal(error: &str) -> bool {
    error.contains("só funciona dentro de um terminal") || error.contains("sessão do terminal ausente")
}

fn call(command: &str, args: Value) -> Result<Response, String> {
    send(command, with_caller(command, args)).map_err(|e| e.message)
}

/// O comando tem que responder ok; a resposta volta para quem quiser olhar o corpo.
fn expect_ok(command: &str, args: Value) -> Result<Value, String> {
    let response = call(command, args)?;
    if response.ok {
        Ok(response.data.unwrap_or(Value::Null))
    } else {
        Err(format!("{command}: {}", response.error.unwrap_or_default()))
    }
}

/// O comando tem que ser recusado com uma mensagem, e a mensagem não pode conter `forbidden`.
fn expect_refused(command: &str, args: Value, forbidden: &[&str]) -> Result<String, String> {
    let response = call(command, args)?;
    if response.ok {
        return Err(format!("{command} devia ser recusado e respondeu ok"));
    }
    let error = response.error.unwrap_or_default();
    if error.is_empty() {
        return Err(format!("{command} foi recusado sem mensagem"));
    }
    if let Some(bad) = forbidden.iter().find(|f| error.contains(**f)) {
        return Err(format!("{command} recusado pelo motivo errado ({bad}): {error}"));
    }
    Ok(error)
}

/// Passos dentro de terminal: recusa por falta de terminal vira "pulado".
fn in_terminal(result: Result<String, String>) -> Outcome {
    match result {
        Ok(detail) => Outcome::Pass(detail),
        Err(e) if needs_terminal(&e) => Outcome::Skip("só vale dentro de um terminal do ADE AGS".into()),
        Err(e) => Outcome::Fail(e),
    }
}

/// O que `--file` faz do lado do CLI, sem app: o arquivo vira o campo `text` do `peer tell`, intacto.
pub(crate) fn file_flag_probe() -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("ags-smoke-{}.txt", std::process::id()));
    std::fs::write(&path, PROBE).map_err(|e| e.to_string())?;
    let args = vec!["smoke-inexistente".to_string(), "--file".to_string(), path.to_string_lossy().into_owned()];
    let parsed = parse_flags(&args, positionals("peer.tell")).and_then(|v| inline_file(v, "peer.tell"));
    let _ = std::fs::remove_file(&path);
    let parsed = parsed?;
    if parsed.get("text").and_then(Value::as_str) != Some(PROBE) {
        return Err("o texto do arquivo não chegou intacto no campo text".into());
    }
    if parsed.get("content").is_some() {
        return Err("o arquivo foi para o campo content, que o peer não lê".into());
    }
    Ok(format!("{} caracteres, aspas/acento/$HOME/crase intactos", PROBE.chars().count()))
}

/// `--file` com arquivo que não existe tem que dar erro de uso, sem mandar nada.
pub(crate) fn missing_file_probe() -> Result<String, String> {
    let args = vec!["smoke-inexistente".to_string(), "--file".to_string(), "arquivo-que-nao-existe.smoke".to_string()];
    match parse_flags(&args, positionals("peer.tell")).and_then(|v| inline_file(v, "peer.tell")) {
        Err(e) if e.contains("No se pudo leer") => Ok("erro de leitura claro, nada enviado".into()),
        Err(e) => Err(format!("erro inesperado: {e}")),
        Ok(_) => Err("aceitou um arquivo que não existe".into()),
    }
}

fn timed(name: &'static str, f: impl FnOnce() -> Outcome) -> Check {
    let started = Instant::now();
    let outcome = f();
    Check { name, outcome, ms: started.elapsed().as_millis() }
}

fn pass(result: Result<String, String>) -> Outcome {
    match result {
        Ok(detail) => Outcome::Pass(detail),
        Err(e) => Outcome::Fail(e),
    }
}

/// O JSON do resultado e se tudo passou. Pura.
pub(crate) fn summarize(checks: &[Check]) -> (Value, bool) {
    let failed = checks.iter().filter(|c| matches!(c.outcome, Outcome::Fail(_))).count();
    let rows: Vec<Value> = checks
        .iter()
        .map(|c| {
            let (status, detail) = match &c.outcome {
                Outcome::Pass(d) => ("pass", d),
                Outcome::Skip(d) => ("skip", d),
                Outcome::Fail(d) => ("fail", d),
            };
            json!({ "name": c.name, "status": status, "detail": detail, "ms": c.ms })
        })
        .collect();
    (json!({ "passed": failed == 0, "failed": failed, "checks": rows }), failed == 0)
}

pub(crate) fn run() -> ExitCode {
    let in_a_terminal = std::env::var("ADE_TAB_ID").is_ok_and(|v| !v.is_empty());
    let mut checks = Vec::new();

    let first = timed("app responde (tab list)", || {
        pass(expect_ok("tab.list", json!({})).map(|d| {
            let tabs = d.get("tabs").and_then(Value::as_array).or_else(|| d.as_array()).map_or(0, Vec::len);
            format!("{tabs} abas")
        }))
    });
    // Sem app não há o que testar: devolve o erro de sempre, com o código de "app fechado".
    if let Outcome::Fail(message) = &first.outcome {
        if message.contains("no parece estar corriendo") || message.contains("handshake") {
            println!("{}", json!({ "error": message }));
            return ExitCode::from(EXIT_NO_APP);
        }
    }
    checks.push(first);

    checks.push(timed("tab output da própria aba", || {
        if !in_a_terminal {
            return Outcome::Skip("sem ADE_TAB_ID: fora de um terminal do ADE AGS".into());
        }
        let tab = std::env::var("ADE_TAB_ID").unwrap_or_default();
        pass(expect_ok("tab.output", json!({ "tab": tab, "lines": 3 })).map(|_| "leu as últimas linhas".into()))
    }));
    checks.push(timed("tab inexistente é recusada", || {
        pass(expect_refused("tab.output", json!({ "tab": "smoke-inexistente", "lines": 1 }), &[]).map(|e| e.chars().take(60).collect()))
    }));
    checks.push(timed("missão inexistente é recusada", || {
        pass(expect_refused("mission.status", json!({ "mission": "smoke-inexistente" }), &[]).map(|e| e.chars().take(60).collect()))
    }));
    checks.push(timed("peers", || in_terminal(expect_ok("peer.list", json!({})).map(|_| "lista a equipe".into()))));
    checks.push(timed("memória: índice", || in_terminal(expect_ok("memory.index", json!({})).map(|_| "índice lido".into()))));
    checks.push(timed("--file chega como text (CLI)", || pass(file_flag_probe())));
    checks.push(timed("--file inexistente dá erro de leitura", || pass(missing_file_probe())));
    checks.push(timed("peer tell a destino inexistente é recusado", || {
        // O texto é o do probe: se o app o recusa, não foi por texto faltando, e nada foi entregue.
        let result = expect_refused("peer.tell", json!({ "to": "smoke-inexistente", "text": PROBE }), &["Falta", "--text"]);
        match result {
            // Recusado por estar fora de um terminal não prova nada sobre o destino: pula.
            Ok(error) if needs_terminal(&error) => Outcome::Skip("só vale dentro de um terminal do ADE AGS".into()),
            other => pass(other.map(|e| format!("recusado sem entregar nada: {}", e.chars().take(50).collect::<String>()))),
        }
    }));

    let (body, passed) = summarize(&checks);
    for c in &checks {
        let (mark, detail) = match &c.outcome {
            Outcome::Pass(d) => ("ok   ", d),
            Outcome::Skip(d) => ("pulou", d),
            Outcome::Fail(d) => ("FALHOU", d),
        };
        eprintln!("{mark} {} — {detail} ({} ms)", c.name, c.ms);
    }
    println!("{body}");
    ExitCode::from(if passed { EXIT_OK } else { EXIT_COMMAND_FAILED })
}
