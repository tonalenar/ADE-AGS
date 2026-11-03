//! Replay de transcript de protocolo (`ade-replay` v2, `kind: "protocolo"`), só nos testes. O v1
//! (`terminal/replay.rs`) toca bytes de PTY nos detectores de tela; este toca as linhas JSON que um agente
//! escreveu no stdio (`claude -p`, `codex app-server`, ACP) no motor de bancada ([`super::bancada`]).
//!
//! Cada fixture são dois arquivos em `conversa/fixtures/protocolo/`:
//! - `<id>.json`: o transcript, com placeholders tipados (`{{session:1}}`, `{{cwd}}`, `{{home}}`), e o
//!   `expected` (o snapshot do que o motor produziu);
//! - `<id>.oracle.json`: o oráculo, escrito à mão (`checks` com as chaves de [`Espera`]). O `refresh` NUNCA
//!   reescreve este arquivo, e se recusa a regravar o snapshot quando o oráculo falha: "o refresh aprovou a
//!   regressão" deixa de ser possível.
//!
//! Modos (`ADE_REPLAY_MODE`): `replay` (padrão: confere oráculo e snapshot), `refresh` (confere o oráculo e
//! regrava o `expected`) e `record` (cria a fixture a partir de um `.jsonl` gravado à mão, ver o doc).
//! O guard recusa a fixture com placeholder desconhecido, sem oráculo, com segredo, ou cuja ferramenta o
//! mapeador não conhece (`ToolKind::Other`, o `UNKNOWN_TOOL` do deepseek-harness).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use super::bancada::{self, conferir, Espera, Evento, Protocolo, Resultado, Saida};

pub const FORMAT: &str = "ade-replay";
pub const VERSION: u64 = 2;
pub const KIND: &str = "protocolo";

/// Os valores dos placeholders. Fixos: o replay é o mesmo em qualquer máquina.
pub const CWD: &str = "/bancada/projeto";
pub const HOME: &str = "/bancada/home";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modo {
    Replay,
    Refresh,
    Record,
}

impl Modo {
    pub fn do_ambiente() -> Result<Modo, String> {
        match std::env::var("ADE_REPLAY_MODE").unwrap_or_default().trim() {
            "" | "replay" => Ok(Modo::Replay),
            "refresh" => Ok(Modo::Refresh),
            "record" => Ok(Modo::Record),
            outro => Err(format!("ADE_REPLAY_MODE={outro}: use replay, refresh ou record")),
        }
    }
}

pub fn pasta() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/conversa/fixtures/protocolo")
}

/// O valor de `{{session:N}}`: um uuid com o N dentro, para o snapshot dizer qual sessão é.
pub fn session_id(n: u64) -> String {
    format!("{n:08x}-0000-4000-8000-{n:012x}")
}

/// Troca os placeholders pelos valores. Um tipo desconhecido (`{{sesion:1}}`, `{{tmp}}`) é erro.
pub fn expandir(texto: &str) -> Result<String, String> {
    let re = regex::Regex::new(r"\{\{([^}]*)\}\}").unwrap();
    let mut erro = None;
    let out = re.replace_all(texto, |c: &regex::Captures| {
        let dentro = &c[1];
        let (tipo, n) = dentro.split_once(':').map(|(t, n)| (t, Some(n))).unwrap_or((dentro, None));
        match (tipo, n.map(str::parse::<u64>)) {
            ("session", Some(Ok(n))) if n > 0 => session_id(n),
            ("cwd", None) => CWD.to_string(),
            ("home", None) => HOME.to_string(),
            _ => {
                erro.get_or_insert_with(|| format!("placeholder desconhecido {{{{{dentro}}}}}: use {{{{session:N}}}}, {{{{cwd}}}} ou {{{{home}}}}"));
                String::new()
            }
        }
    });
    match erro {
        Some(e) => Err(e),
        None => Ok(out.into_owned()),
    }
}

/// O caminho inverso, para o snapshot gravado não ter os valores concretos: as sessões de 1 a `max_session`,
/// o `cwd` e o `home`.
pub fn recolocar(texto: &str, max_session: u64) -> String {
    let mut out = texto.to_string();
    for n in 1..=max_session {
        out = out.replace(&session_id(n), &format!("{{{{session:{n}}}}}"));
    }
    out.replace(CWD, "{{cwd}}").replace(HOME, "{{home}}")
}

/// `record`: o texto gravado de verdade com os valores da máquina trocados por placeholders. Os uuids viram
/// `{{session:N}}` na ordem em que aparecem; o `cwd` e o `home` dados, `{{cwd}}` e `{{home}}`.
pub fn normalizar(texto: &str, cwd: Option<&str>, home: Option<&str>) -> String {
    let re = regex::Regex::new(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}").unwrap();
    let mut vistos: BTreeMap<String, usize> = BTreeMap::new();
    let mut out = re.replace_all(texto, |c: &regex::Captures| {
        let proximo = vistos.len() + 1;
        let n = *vistos.entry(c[0].to_lowercase()).or_insert(proximo);
        format!("{{{{session:{n}}}}}")
    }).into_owned();
    // O cwd costuma estar dentro do home: troca o mais longo primeiro.
    for (valor, ph) in [(cwd, "{{cwd}}"), (home, "{{home}}")] {
        if let Some(v) = valor.filter(|v| v.len() > 1) {
            out = out.replace(v, ph);
        }
    }
    out
}

/// Uma linha do transcript: o que o agente escreveu (`out`), uma linha crua que não é JSON (`raw`), o que o
/// app escreveu (`in`, só para ler: o motor de bancada não usa) ou o processo fechando (`close`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entrada {
    pub at_ms: u64,
    #[serde(default)]
    pub out: Option<Value>,
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default, rename = "in")]
    pub entrada: Option<Value>,
    #[serde(default)]
    pub close: Option<Fecha>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fecha {
    #[serde(default)]
    pub stderr: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fixture {
    pub format: String,
    pub version: u64,
    pub kind: String,
    pub id: String,
    pub agent: String,
    pub protocol: Protocolo,
    pub title: String,
    pub origin: Value,
    pub transcript: Vec<Entrada>,
    #[serde(default)]
    pub expected: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub label: String,
    pub expect: Espera,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Oraculo {
    pub checks: Vec<Check>,
}

/// Lê a fixture (já com os placeholders trocados) e confere o formato.
pub fn ler(texto: &str) -> Result<Fixture, String> {
    let fixture: Fixture = serde_json::from_str(&expandir(texto)?).map_err(|e| format!("fixture inválida: {e}"))?;
    if fixture.format != FORMAT || fixture.version != VERSION || fixture.kind != KIND {
        return Err(format!("esperava {FORMAT} v{VERSION} kind {KIND}, veio {} v{} kind {}", fixture.format, fixture.version, fixture.kind));
    }
    if fixture.agent.trim().is_empty() || fixture.title.trim().is_empty() {
        return Err(format!("{}: `agent` e `title` não podem ficar vazios", fixture.id));
    }
    if fixture.origin.get("kind").and_then(Value::as_str).is_none_or(|k| k != "synthesized" && k != "recorded") {
        return Err(format!("{}: `origin.kind` é `synthesized` ou `recorded`", fixture.id));
    }
    let mut antes = 0;
    for (i, e) in fixture.transcript.iter().enumerate() {
        let n = [e.out.is_some(), e.raw.is_some(), e.entrada.is_some(), e.close.is_some()].iter().filter(|x| **x).count();
        if n != 1 {
            return Err(format!("transcript[{i}]: exatamente um de out, raw, in, close"));
        }
        if e.at_ms < antes {
            return Err(format!("transcript[{i}]: atMs fora de ordem"));
        }
        antes = e.at_ms;
    }
    Ok(fixture)
}

pub fn ler_oraculo(texto: &str) -> Result<Oraculo, String> {
    let oraculo: Oraculo = serde_json::from_str(texto).map_err(|e| format!("oráculo inválido: {e}"))?;
    if oraculo.checks.is_empty() {
        return Err("o oráculo não tem nenhum check: escreva à mão ao menos um (o snapshot sozinho não prova nada)".into());
    }
    Ok(oraculo)
}

/// O transcript como o fake de agente escreveria (só `out`, `raw` e `close`).
pub fn saidas(fixture: &Fixture) -> Vec<Saida> {
    fixture.transcript.iter().filter_map(|e| {
        let evento = if let Some(out) = &e.out {
            Evento::Linha(out.to_string())
        } else if let Some(raw) = &e.raw {
            Evento::Linha(raw.clone())
        } else {
            Evento::Fecha { stderr: e.close.as_ref()?.stderr.clone() }
        };
        Some(Saida { at_ms: e.at_ms, evento })
    }).collect()
}

/// O snapshot: o que o motor produziu, com os placeholders de volta no lugar dos valores.
pub fn snapshot(r: &Resultado) -> Value {
    let fim = r.fim.as_ref().map(|f| json!({ "interrupted": f.interrupted, "error": f.error, "durationMs": f.duration_ms }));
    let valor = json!({
        "sessao": r.sessao(),
        "aberturaFalhou": r.abertura.as_ref().and_then(|a| a.as_ref().err()),
        "itens": r.itens,
        "deltas": r.deltas,
        "pedidos": r.pedidos.iter().map(|p| json!({ "kind": p.kind, "title": p.title })).collect::<Vec<_>>(),
        "fim": fim,
        "caiu": r.caiu,
        "avisos": r.avisos,
        "ignoradas": r.ignoradas,
    });
    serde_json::from_str(&recolocar(&valor.to_string(), 99)).unwrap_or(valor)
}

/// O que o replay de uma fixture deu. `Ok(snapshot novo)` = guard e oráculo passaram; quem chama compara (replay)
/// ou grava (refresh).
pub fn tocar(fixture: &Fixture, oraculo: &Oraculo) -> Result<Value, String> {
    let r = bancada::rodar(fixture.protocol, &saidas(fixture));
    let desconhecidas = r.ferramentas_desconhecidas();
    if !desconhecidas.is_empty() {
        return Err(format!(
            "{}: ferramenta que o mapeador não conhece ({}): mapeie em `canal::timeline` antes de gravar a fixture",
            fixture.id,
            desconhecidas.join(", ")
        ));
    }
    let expand = |s: &str| expandir(s).unwrap_or_else(|_| s.to_string());
    let mut falhas = Vec::new();
    for check in &oraculo.checks {
        for erro in conferir(&check.expect, &r, fixture.protocol, &expand) {
            falhas.push(format!("{} — {}: {erro}", fixture.id, check.label));
        }
    }
    if !falhas.is_empty() {
        return Err(format!("o oráculo falhou (o refresh não regrava nada assim):\n{}", falhas.join("\n")));
    }
    Ok(snapshot(&r))
}

/// Modo `replay`: o snapshot tem que ser o gravado.
pub fn conferir_snapshot(fixture: &Fixture, novo: &Value) -> Result<(), String> {
    let Some(gravado) = &fixture.expected else {
        return Err(format!("{}: sem `expected`; rode `ADE_REPLAY_MODE=refresh cargo test --lib replay_protocolo`", fixture.id));
    };
    // O gravado foi lido com os placeholders expandidos: recoloca para comparar com o novo.
    let gravado: Value = serde_json::from_str(&recolocar(&gravado.to_string(), 99)).unwrap_or_else(|_| gravado.clone());
    if &gravado != novo {
        return Err(format!(
            "{}: o snapshot mudou. Se a mudança é a certa, rode o refresh e revise o diff.\n--- gravado\n{}\n--- agora\n{}",
            fixture.id,
            serde_json::to_string_pretty(&gravado).unwrap_or_default(),
            serde_json::to_string_pretty(novo).unwrap_or_default()
        ));
    }
    Ok(())
}

/// Modo `refresh`: o texto do arquivo com o `expected` novo e o resto como estava (o JSON é lido como árvore e
/// regravado com a mesma ordem de chaves do arquivo; o oráculo fica em outro arquivo e nem é aberto para escrita).
pub fn com_snapshot(texto_original: &str, novo: &Value) -> Result<String, String> {
    let mut arvore: Value = serde_json::from_str(texto_original).map_err(|e| e.to_string())?;
    arvore["expected"] = novo.clone();
    let mut out = serde_json::to_string_pretty(&arvore).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Modo `record`: a fixture a partir de um `.jsonl` gravado (uma linha por saída do agente, como veio do stdout).
/// Recusa se o texto parece ter segredo. O `expected` sai vazio: o refresh preenche depois do oráculo escrito.
pub fn gravar(id: &str, agent: &str, protocol: &str, jsonl: &str, cwd: Option<&str>, home: Option<&str>) -> Result<String, String> {
    if crate::memory::agent::looks_like_secret(jsonl) {
        return Err("o texto gravado parece ter um segredo (token, senha, chave): nada foi salvo".into());
    }
    let normal = normalizar(jsonl, cwd, home);
    let transcript: Vec<Value> = normal.lines().filter(|l| !l.trim().is_empty()).enumerate().map(|(i, line)| {
        let at = i as u64 * 10;
        match serde_json::from_str::<Value>(line) {
            Ok(v) => json!({ "atMs": at, "out": v }),
            Err(_) => json!({ "atMs": at, "raw": line }),
        }
    }).collect();
    let fixture = json!({
        "format": FORMAT, "version": VERSION, "kind": KIND, "id": id, "agent": agent, "protocol": protocol,
        "title": "TROQUE: o que este transcript cobre",
        "origin": { "kind": "recorded", "basis": "TROQUE: versão da CLI e como foi gravado", "recordedAt": crate::util::now_ts() },
        "transcript": transcript,
    });
    let mut out = serde_json::to_string_pretty(&fixture).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Os pares (fixture, oráculo) da pasta, por id, na ordem do nome.
pub fn fixtures(dir: &Path) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut out = Vec::new();
    let mut nomes: Vec<PathBuf> = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json") && !p.to_string_lossy().ends_with(".oracle.json"))
        .collect();
    nomes.sort();
    for fixture in nomes {
        let oraculo = fixture.with_extension("oracle.json");
        out.push((fixture, oraculo));
    }
    Ok(out)
}
