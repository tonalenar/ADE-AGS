//! Testes por replay do lado do backend: as fixtures de `src/features/terminal/tests/fixtures/replay`
//! (as mesmas do vitest) passam, no tempo em que chegaram, pelos detectores que o envio de mensagens
//! usa (`tabs.rs`, `peers.rs`). Formato em `docs/ade-ags/REPLAY_TESTES.md`.
//!
//! O backend não desenha a tela: olha o fim cru do PTY, sem escapes (`tail_of` + `strip_ansi`). Aqui
//! o "buffer do PTY" no instante `t` é a soma dos pedaços com `atMs <= t`, e cada chave lê o mesmo
//! trecho que o código de produção lê (os tamanhos de `tabs.rs`).

use super::peers::{arrived, snippet_of};
use super::tabs::{pending_paste_in, text_shown_in, typed_text_in, varied_text, working_in};
use crate::orchestrator::digest::strip_ansi;
use crate::terminal::replay::{load_fixtures, Fixture};
use serde_json::Value;

/// As chaves que este harness avalia (o resto é do front; ver `replayHarness.ts`).
const RUST_KEYS: &[&str] = &["working", "pastePending", "typedPending", "textShown", "fresh", "enterRetry", "arrived", "screenContains"];
/// As do front: aceitas e ignoradas aqui (uma chave fora das duas listas é erro de digitação).
const TS_KEYS: &[&str] = &["working", "pastePending", "typedPending", "waitingApproval", "screenQuestion", "asksToClose", "stalled", "loopSuspect", "screenContains"];

/// `tail_of(pty, max)` sobre um buffer em memória: os últimos `max` bytes, sem cortar UTF-8.
fn tail(buffer: &[u8], max: usize) -> String {
    let start = crate::terminal::tail_start(buffer, max);
    String::from_utf8_lossy(&buffer[start..]).into_owned()
}

/// O que os detectores do backend dizem no instante `at`, com a janela de saída nova desde `since`.
fn verdict(fixture: &Fixture, at: u64, since: Option<u64>) -> Result<serde_json::Map<String, Value>, String> {
    let buffer = fixture.output_until(at)?;
    let message = fixture.message.clone().unwrap_or_default();
    // `tui_working`: os últimos 4 KB.
    let working = working_in(&strip_ansi(&tail(&buffer, 4096)));
    // `paste_still_pending` e `text_on_screen`: os últimos 32 KB.
    let screen = strip_ansi(&tail(&buffer, 32_768));
    let marker = pending_paste_in(&screen);
    let typed = typed_text_in(&screen, &message);
    let mut out = serde_json::Map::new();
    out.insert("working".into(), working.into());
    out.insert("pastePending".into(), marker.into());
    out.insert("typedPending".into(), typed.into());
    out.insert("textShown".into(), text_shown_in(&screen, &message).into());
    out.insert("screenContains".into(), strip_ansi(&tail(&buffer, 65_536)).into());
    if let Some(since) = since {
        let before = fixture.output_until(since)?;
        // `submit_prompt_seen`: o que saiu depois do Enter (até 64 KB) tem texto variado?
        let wrote = buffer.len().saturating_sub(before.len());
        let fresh = varied_text(&strip_ansi(&tail(&buffer, wrote.min(65_536))));
        out.insert("fresh".into(), fresh.into());
        // A mesma decisão do laço de `submit_prompt_seen` (tabs.rs): sem rodapé de trabalho, sem saída
        // nova e com o colado (marcador ou texto inteiro) ainda na caixa, manda outro Enter.
        out.insert("enterRetry".into(), (!working && !fresh && (marker || typed)).into());
        // `submit_confirmed` (peers.rs): sem trecho para conferir, conta como chegou.
        let landed = match snippet_of(&message) {
            Some(snippet) => arrived(&strip_ansi(&tail(&before, 65_536)), &strip_ansi(&tail(&buffer, 65_536)), &snippet),
            None => true,
        };
        out.insert("arrived".into(), landed.into());
    }
    Ok(out)
}

/// As divergências de uma fixture (vazio = passou), já explicadas.
fn replay(fixture: &Fixture) -> Vec<String> {
    let mut problems = Vec::new();
    for cp in &fixture.checkpoints {
        let got = match verdict(fixture, cp.at_ms, cp.since) {
            Ok(got) => got,
            Err(error) => {
                problems.push(format!("{} ms: {error}", cp.at_ms));
                continue;
            }
        };
        let xfail: &[String] = cp.xfail.as_ref().map(|x| x.rust.as_slice()).unwrap_or(&[]);
        for (key, expected) in &cp.expect {
            if !RUST_KEYS.contains(&key.as_str()) {
                continue;
            }
            let Some(actual) = got.get(key) else {
                problems.push(format!("{} ms \"{}\": \"{key}\" precisa de since", cp.at_ms, cp.label));
                continue;
            };
            let ok = match (key.as_str(), expected, actual) {
                ("screenContains", Value::String(needle), Value::String(screen)) => screen.contains(needle.as_str()),
                _ => actual == expected,
            };
            let known = xfail.iter().any(|k| k == key);
            if ok == known {
                let shown = if key == "screenContains" { "(outra tela)".to_string() } else { actual.to_string() };
                problems.push(if known {
                    format!("{} ms \"{}\": {key} já acerta ({shown}). Tire \"{key}\" do xfail.rust", cp.at_ms, cp.label)
                } else {
                    format!("{} ms \"{}\": {key} esperado {expected}, veio {shown}", cp.at_ms, cp.label)
                });
            }
        }
    }
    problems
}

#[test]
fn as_fixtures_de_replay_sao_validas() {
    let fixtures = load_fixtures();
    assert!(!fixtures.is_empty(), "nenhuma fixture em {}", crate::terminal::replay::FIXTURES_DIR);
    for (file, f) in &fixtures {
        assert_eq!(format!("{}.json", f.id), *file, "o id é o nome do arquivo");
        assert_eq!((f.format.as_str(), f.version), ("ade-replay", 1), "{file}");
        assert!(!f.agent.is_empty() && !f.title.is_empty(), "{file}: agent e title");
        assert!(matches!(f.origin.kind.as_str(), "synthesized" | "recorded"), "{file}: origin.kind");
        assert!(!f.origin.basis.trim().is_empty(), "{file}: origin.basis");
        assert!(f.chunks.windows(2).all(|w| w[0].at_ms <= w[1].at_ms), "{file}: pedaços fora de ordem");
        for chunk in &f.chunks {
            chunk.bytes().unwrap_or_else(|e| panic!("{file}: {e}"));
        }
        for cp in &f.checkpoints {
            for key in cp.expect.keys() {
                assert!(RUST_KEYS.contains(&key.as_str()) || TS_KEYS.contains(&key.as_str()), "{file}: chave desconhecida {key}");
            }
            if let Some(x) = &cp.xfail {
                assert!(!x.reason.trim().is_empty(), "{file} {} ms: xfail sem reason", cp.at_ms);
                for key in x.rust.iter().chain(&x.ts) {
                    assert!(cp.expect.contains_key(key), "{file} {} ms: xfail de {key}, que não está no expect", cp.at_ms);
                }
            }
        }
    }
}

#[test]
fn replay_das_telas_pelos_detectores_do_backend() {
    let failures: Vec<String> = load_fixtures()
        .iter()
        .flat_map(|(file, f)| replay(f).into_iter().map(move |p| format!("{file} ({}): {p}", f.origin.kind)))
        .collect();
    assert!(failures.is_empty(), "o replay divergiu:\n{}", failures.join("\n"));
}

/// O harness é ele mesmo testado: uma fixture inventada com a resposta errada tem de falhar.
#[test]
fn o_harness_acusa_a_expectativa_errada_e_o_xfail_que_ja_passa() {
    let fixture: Fixture = serde_json::from_value(serde_json::json!({
        "format": "ade-replay", "version": 1, "id": "x", "agent": "codex", "title": "x",
        "origin": { "kind": "synthesized", "basis": "teste do harness" },
        "chunks": [{ "atMs": 0, "data": "\u{1b}[1mWorking\u{1b}[0m (1s • esc to interrupt)" }],
        "checkpoints": [
            { "atMs": 10, "expect": { "working": false } },
            { "atMs": 10, "expect": { "working": true }, "xfail": { "rust": ["working"], "reason": "x" } },
            { "atMs": 10, "expect": { "working": true, "waitingApproval": true } }
        ]
    }))
    .unwrap();
    let problems = replay(&fixture);
    assert_eq!(problems.len(), 2, "{problems:?}");
    assert!(problems[0].contains("esperado false"));
    assert!(problems[1].contains("Tire \"working\" do xfail.rust"));
}
