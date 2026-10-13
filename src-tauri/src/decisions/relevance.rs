//! O Jev escolhe, entre as memórias aprovadas, as que importam para o OBJETIVO da missão, em vez de o
//! briefing receber o índice inteiro. Mesmo modelo do `delivery.rs`:
//!
//! - fica DESLIGADO por padrão (`decisions.point.memory_relevance`); desligado, o briefing não muda;
//! - o objetivo e o começo de cada memória saem da máquina: só `OBJECTIVE_CHARS` e `BODY_CHARS`, e nada
//!   que o detector de segredos marque (a memória marcada nem é enviada);
//! - qualquer falha (desligado, sem chave, timeout, resposta incompleta, nenhuma escolhida) devolve `None`
//!   e o briefing segue com o índice de sempre;
//! - cada consulta vira uma linha do log (`memory_relevance`), com a busca local ao lado, para medir quem acerta.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

use crate::database::DbConnection;
use crate::memory::search::{self, Doc};
use crate::memory::usage::{self, UsageRow};
use crate::util::now_ts;

use super::config;
use super::http;
use super::log::{self, LogRow};
use super::points::{memory_secret, POINT_RELEVANCE};
use super::protocol::{canonical, canonical_labels, primary_metrics, DecisionAnswer, DecisionRequest, Question};

/// Quantas memórias (no máximo) entram na consulta; as que passam disso não são consideradas.
pub const MAX_CANDIDATES: usize = 30;
/// Quanto do objetivo vai ao provedor.
pub const OBJECTIVE_CHARS: usize = 600;
/// Quanto do corpo de cada memória vai ao provedor.
pub const BODY_CHARS: usize = 160;
/// Quantas memórias a busca local aponta, para o log comparar com a escolha do Jev.
const LOCAL_TOP: usize = 8;
/// Teto de memórias escolhidas: o mesmo de entradas do briefing.
pub const MAX_CHOSEN: usize = 10;
/// Orçamento de caracteres do bloco do briefing (o mesmo de `missions::memory_context_text`).
const BRIEFING_CHARS: usize = 2_600;

/// Uma memória aprovada como o Jev a vê. `kind` é o tipo (`note`, `constraint`…).
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub key: String,
    pub kind: String,
    pub body: String,
}

/// Colapsa espaços, corta em `max` caracteres e marca o corte. Pura.
fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max {
        flat.chars().take(max).collect::<String>() + "…"
    } else {
        flat
    }
}

/// As candidatas que saem: as primeiras `MAX_CANDIDATES`, sem segredo e sem chave repetida (vale a
/// primeira). Pura.
fn considered(candidates: &[Candidate]) -> Vec<&Candidate> {
    let mut seen = HashSet::new();
    candidates
        .iter()
        .take(MAX_CANDIDATES)
        .filter(|c| !memory_secret(&c.key, &c.body, None))
        .filter(|c| seen.insert(c.key.as_str()))
        .collect()
}

/// O pedido: o objetivo, a lista numerada e uma pergunta `sim`/`nao` por memória (`m0`, `m1`…). A
/// heurística é `sim` quando a busca local apontou a chave. Pura.
pub fn request_for(objective: &str, candidates: &[&Candidate], local_top: &[String]) -> DecisionRequest {
    let mut state = format!("objetivo: {}\ncandidatas:", clip(objective, OBJECTIVE_CHARS));
    let mut questions = BTreeMap::new();
    let mut heuristic = BTreeMap::new();
    for (i, candidate) in candidates.iter().enumerate() {
        state.push_str(&format!(
            "\n{i}. {} ({}): {}",
            clip(&candidate.key, 200),
            candidate.kind,
            clip(&candidate.body, BODY_CHARS)
        ));
        questions.insert(
            format!("m{i}"),
            Question::choice(
                "Esta memória ajuda a cumprir o objetivo?",
                &[
                    ("sim", "a memória trata do assunto do objetivo e deve entrar no briefing"),
                    ("nao", "é de outro assunto ou não ajuda este objetivo"),
                ],
            ),
        );
        let local = if local_top.contains(&candidate.key) { "sim" } else { "nao" };
        heuristic.insert(format!("m{i}"), local.to_string());
    }
    DecisionRequest { state, questions, model: String::new(), heuristic }
}

/// Lê a resposta: cada candidata precisa de `sim` ou `nao` (qualquer outra coisa, ou uma resposta
/// faltando, é resposta incompleta). Devolve as `sim`, da mais provável para a menos, truncadas a
/// `max`; zero escolhidas também é `None`. Pura.
pub(super) fn read_chosen(answers: &BTreeMap<String, DecisionAnswer>, keys: &[String], max: usize) -> Option<Vec<String>> {
    let mut picked: Vec<(usize, f64)> = Vec::new();
    for (i, _) in keys.iter().enumerate() {
        let answer = answers.get(&format!("m{i}"))?;
        match answer.label.as_str() {
            "sim" => picked.push((i, answer.probability.unwrap_or(0.0))),
            "nao" => {}
            _ => return None,
        }
    }
    picked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then(a.0.cmp(&b.0)));
    let chosen: Vec<String> = picked.into_iter().take(max).map(|(i, _)| keys[i].clone()).collect();
    (!chosen.is_empty()).then_some(chosen)
}

/// Pergunta ao provedor principal e devolve as chaves escolhidas. Bloqueante: chamar de `spawn_blocking`.
/// Não segura o mutex do banco durante a chamada HTTP.
pub fn select(
    db: &DbConnection,
    objective: &str,
    candidates: &[Candidate],
    local_top: &[String],
    max: usize,
) -> Option<Vec<String>> {
    let settings = {
        let conn = db.lock().ok()?;
        config::load(&conn).ok()?
    };
    if !settings.active() || !settings.allows(POINT_RELEVANCE) {
        return None;
    }
    // Objetivo vazio ou com segredo: nada sai, nenhuma memória vai ao provedor.
    if objective.trim().is_empty() || memory_secret("", objective, None) {
        return None;
    }
    let api_key = config::load_key();
    select_with(db, &settings, api_key.as_deref(), objective, candidates, local_top, max)
}

pub(super) fn select_with(
    db: &DbConnection,
    settings: &config::Settings,
    api_key: Option<&str>,
    objective: &str,
    candidates: &[Candidate],
    local_top: &[String],
    max: usize,
) -> Option<Vec<String>> {
    let considered = considered(candidates);
    if considered.is_empty() || max == 0 {
        return None;
    }
    let keys: Vec<String> = considered.iter().map(|c| c.key.clone()).collect();
    let request = request_for(objective, &considered, local_top);
    let started = Instant::now();
    let result = http::execute(settings, api_key, &request);
    let latency = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let state_hash = super::protocol::state_hash(&request.state);
    let (decision, error, probability, confidence, input, output) = match &result {
        Ok(response) => {
            let (probability, confidence) = primary_metrics(&response.answers);
            (Some(canonical(&response.answers)), None, probability, confidence, response.input_tokens, response.output_tokens)
        }
        Err(error) => (None, Some(super::protocol::truncate_chars(&error.code(), 300)), None, None, 0, 0),
    };
    if let Ok(conn) = db.lock() {
        let _ = log::record(
            &conn,
            &LogRow {
                ts: now_ts(),
                point: POINT_RELEVANCE.into(),
                provider: settings.provider.as_str().into(),
                model: settings.provider.coerce_model(&settings.model),
                state_hash,
                heuristic: canonical_labels(&request.heuristic),
                provider_decision: decision,
                probability,
                confidence,
                latency_ms: Some(latency),
                error,
                input_tokens: Some(input),
                output_tokens: Some(output),
            },
        );
    }
    let response = result.ok()?;
    read_chosen(&response.answers, &keys, max)
}

/// Se o ponto está ligado e o provedor configurado. Uma leitura de configuração, sem rede.
fn enabled(db: &DbConnection) -> bool {
    let Ok(conn) = db.lock() else {
        return false;
    };
    config::load(&conn).is_ok_and(|settings| settings.active() && settings.allows(POINT_RELEVANCE))
}

/// O texto do briefing com só as memórias escolhidas: as mesmas linhas de `briefing_block`, e uma
/// linha a mais dizendo quantas ficaram de fora. Pura.
fn briefing_text(docs: &[Doc], chosen: &[usize], mission_id: &str, objective: &str) -> String {
    let picked: Vec<Doc> = chosen.iter().map(|&i| docs[i].clone()).collect();
    let block = search::briefing_block(&picked, mission_id, objective, MAX_CHOSEN, BRIEFING_CHARS);
    let outside = docs.len().saturating_sub(picked.len());
    if outside == 0 || block.is_empty() {
        return block;
    }
    let line = format!("- (+{outside} outras memórias: use ags memory search)");
    match block.find("\nPara buscar mais:") {
        Some(at) => {
            let mut out = block.clone();
            out.insert_str(at, &format!("\n{line}"));
            out
        }
        None => format!("{block}\n{line}"),
    }
}

/// O que o briefing antigo sempre fixava continua fixo: restrições e memórias de prioridade 5 ou mais entram
/// mesmo que o Jev não as escolha (uma restrição esquecida custa mais que uma linha a mais). Vêm primeiro, sem
/// repetir o que o Jev já escolheu. Pura.
pub(crate) fn with_pinned(docs: &[Doc], picked: &[usize]) -> Vec<usize> {
    let mut out: Vec<usize> = docs
        .iter()
        .enumerate()
        .filter(|(i, doc)| (doc.kind == "constraint" || doc.priority >= 5) && !memory_secret(&doc.key, &doc.body, None) && !picked.contains(i))
        .map(|(i, _)| i)
        .collect();
    out.extend(picked.iter().copied());
    out
}

/// O briefing da missão com a escolha do Jev, ou `None` (desligado, sem chave, falha, nada escolhido)
/// para o chamador usar o índice de sempre. Registra a injeção em `memory_usage` quando escolhe.
pub(crate) fn briefing(db: &DbConnection, workspace_id: &str, mission_id: &str, objective: &str, docs: &[Doc]) -> Option<String> {
    if docs.is_empty() || !enabled(db) {
        return None;
    }
    // A busca local é a referência de comparação: o que o app escolheria sozinho.
    let ranked = search::rank(docs, objective, docs.len());
    let local_top: Vec<String> = ranked.iter().take(LOCAL_TOP).map(|hit| hit.key.clone()).collect();
    // Ordem: primeiro o que a busca local achou, depois o resto na ordem do carregamento.
    let mut order: Vec<usize> = ranked
        .iter()
        .filter_map(|hit| docs.iter().position(|doc| doc.entry_id == hit.entry_id))
        .collect();
    let placed: HashSet<usize> = order.iter().copied().collect();
    order.extend((0..docs.len()).filter(|i| !placed.contains(i)));
    order.truncate(MAX_CANDIDATES);
    let candidates: Vec<Candidate> = order
        .iter()
        .map(|&i| Candidate { key: docs[i].key.clone(), kind: docs[i].kind.clone(), body: docs[i].body.clone() })
        .collect();
    let keys = select(db, objective, &candidates, &local_top, MAX_CHOSEN)?;
    // Chave → índice do doc, pela mesma regra de `considered`: sem segredo, vale a primeira.
    let mut index_of: HashMap<&str, usize> = HashMap::new();
    for &i in &order {
        let doc = &docs[i];
        if !memory_secret(&doc.key, &doc.body, None) {
            index_of.entry(doc.key.as_str()).or_insert(i);
        }
    }
    let picked: Vec<usize> = keys.iter().filter_map(|key| index_of.get(key.as_str()).copied()).collect();
    if picked.is_empty() {
        return None;
    }
    let chosen = with_pinned(docs, &picked);
    let text = briefing_text(docs, &chosen, mission_id, objective);
    if let Ok(conn) = db.lock() {
        usage::record(
            &conn,
            &UsageRow {
                ts: usage::now(),
                workspace_id,
                mission_id: Some(mission_id),
                tab_id: None,
                action: "injected",
                query: None,
                hits: u32::try_from(keys.len()).unwrap_or(u32::MAX),
                entry_keys: &keys,
            },
        );
    }
    Some(text)
}

#[cfg(test)]
mod pinned_tests {
    use super::*;

    fn doc(key: &str, kind: &str, priority: i64) -> Doc {
        Doc { entry_id: key.into(), scope: "workspace".into(), key: key.into(), kind: kind.into(), priority, body: "corpo".into() }
    }

    #[test]
    fn restricoes_e_prioridade_alta_continuam_fixas_sem_repetir_o_que_o_jev_escolheu() {
        let docs = vec![doc("a", "note", 0), doc("regra", "constraint", 0), doc("alta", "note", 5), doc("b", "note", 4), doc("c", "constraint", 9)];
        assert_eq!(with_pinned(&docs, &[0, 4]), vec![1, 2, 0, 4]);
        assert_eq!(with_pinned(&docs, &[3]), vec![1, 2, 4, 3]);
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use rusqlite::Connection;

    use super::*;

    fn db_with_settings(settings: &config::Settings) -> DbConnection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        log::migrate(&conn).unwrap();
        config::persist(&conn, settings).unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn on(base_url: String) -> config::Settings {
        config::Settings {
            enabled: true,
            provider: config::ProviderKind::LayaLocal,
            base_url,
            model: "multilingual".into(),
            timeout_ms: 1_000,
            memory_relevance: true,
            ..config::Settings::default()
        }
    }

    /// Um servidor que responde uma vez com `body`.
    fn serve(status: u16, body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_string();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 16_384];
                let _ = stream.read(&mut buf);
                let header = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        format!("http://{address}")
    }

    fn cand(key: &str, body: &str) -> Candidate {
        Candidate { key: key.into(), kind: "note".into(), body: body.into() }
    }

    fn doc(entry: &str, key: &str, body: &str) -> Doc {
        Doc { entry_id: entry.into(), scope: "workspace".into(), key: key.into(), kind: "note".into(), priority: 0, body: body.into() }
    }

    fn answers(pairs: &[(&str, &str, f64)]) -> BTreeMap<String, DecisionAnswer> {
        pairs
            .iter()
            .map(|(id, label, p)| {
                ((*id).to_string(), DecisionAnswer { label: (*label).into(), probability: Some(*p), confidence: Some(0.9) })
            })
            .collect()
    }

    fn log_rows(db: &DbConnection) -> i64 {
        db.lock().unwrap().query_row("SELECT COUNT(*) FROM decision_shadow_log", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_pergunta_leva_o_objetivo_a_lista_e_a_busca_local_como_rotulo() {
        let a = cand("stack", "Usar pnpm no frontend.");
        let b = cand("deploy", "Deploy só pela branch master.");
        let request = request_for("Corrigir o build do frontend", &[&a, &b], &["stack".into()]);
        assert!(request.state.starts_with("objetivo: Corrigir o build do frontend\ncandidatas:"));
        assert!(request.state.contains("\n0. stack (note): Usar pnpm no frontend."));
        assert!(request.state.contains("\n1. deploy (note): Deploy só pela branch master."));
        assert_eq!(request.questions.len(), 2);
        assert!(request.questions.contains_key("m0") && request.questions.contains_key("m1"));
        assert_eq!(request.heuristic.get("m0").map(String::as_str), Some("sim"));
        assert_eq!(request.heuristic.get("m1").map(String::as_str), Some("nao"));
    }

    #[test]
    fn corta_objetivo_corpo_e_limita_a_trinta_candidatas() {
        let long_body = "x".repeat(500);
        let all: Vec<Candidate> = (0..45).map(|i| cand(&format!("k{i}"), &long_body)).collect();
        let refs: Vec<&Candidate> = considered(&all);
        assert_eq!(refs.len(), MAX_CANDIDATES);
        let objective = "o".repeat(900);
        let request = request_for(&objective, &refs, &[]);
        let objective_line = request.state.lines().next().unwrap();
        assert!(objective_line.chars().count() <= "objetivo: ".len() + OBJECTIVE_CHARS + 1);
        assert_eq!(request.questions.len(), MAX_CANDIDATES);
        let body_line = request.state.lines().find(|l| l.starts_with("0. ")).unwrap();
        assert!(body_line.chars().count() < BODY_CHARS + 40);
    }

    #[test]
    fn so_vale_sim_truncado_em_ordem_de_probabilidade() {
        let keys: Vec<String> = ["k0", "k1", "k2", "k3"].iter().map(|s| s.to_string()).collect();
        let answered = answers(&[("m0", "sim", 0.6), ("m1", "sim", 0.9), ("m2", "nao", 0.8), ("m3", "sim", 0.95)]);
        assert_eq!(read_chosen(&answered, &keys, 2), Some(vec!["k3".into(), "k1".into()]));
        assert_eq!(read_chosen(&answered, &keys, 10), Some(vec!["k3".into(), "k1".into(), "k0".into()]));
    }

    #[test]
    fn resposta_incompleta_ou_fora_do_vocabulario_ou_sem_escolha_e_none() {
        let keys: Vec<String> = ["k0", "k1"].iter().map(|s| s.to_string()).collect();
        assert_eq!(read_chosen(&answers(&[("m0", "sim", 0.9)]), &keys, 5), None, "falta m1");
        assert_eq!(read_chosen(&answers(&[("m0", "sim", 0.9), ("m1", "talvez", 0.5)]), &keys, 5), None);
        assert_eq!(read_chosen(&answers(&[("m0", "nao", 0.9), ("m1", "nao", 0.9)]), &keys, 5), None, "zero escolhidas");
    }

    #[test]
    fn segredo_no_objetivo_ou_no_corpo_nao_sai() {
        let db = db_with_settings(&on("http://localhost:8000".into()));
        let candidates = vec![cand("stack", "Usar pnpm."), cand("db", "Banco de teste: api_key=sk-live-AAAABBBBCCCCDDDD")];
        // O objetivo marcado: nada é enviado (e nem há log).
        assert_eq!(select(&db, "a api_key=sk-live-AAAABBBBCCCCDDDD é a chave de produção", &candidates, &[], 5), None);
        assert_eq!(log_rows(&db), 0);
        // O corpo marcado é excluído da consulta: só a primeira candidata segue.
        let kept: Vec<&Candidate> = considered(&candidates);
        assert_eq!(kept.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), vec!["stack"]);
        let request = request_for("objetivo", &kept, &[]);
        assert!(!request.state.contains("sk-live"));
    }

    #[test]
    fn o_provedor_escolhe_e_a_consulta_vira_uma_linha_do_log() {
        let body = r#"{"model":"multilingual","answers":{"m0":{"type":"choice","choice":"sim","probabilities":{"sim":0.91,"nao":0.09},"confidence":0.91},"m1":{"type":"choice","choice":"nao","probabilities":{"sim":0.2,"nao":0.8},"confidence":0.8}},"usage":{"input_tokens":40,"output_tokens":4}}"#;
        let base = serve(200, body);
        let settings = on(base);
        let db = db_with_settings(&settings);
        let candidates = vec![cand("stack", "Usar pnpm."), cand("cores", "Paleta azul.")];
        let chosen = select_with(&db, &settings, None, "Corrigir o build", &candidates, &["stack".into()], 5);
        assert_eq!(chosen, Some(vec!["stack".into()]));
        let (point, heuristic): (String, String) = db
            .lock()
            .unwrap()
            .query_row("SELECT point, heuristic FROM decision_shadow_log", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(point, "memory_relevance");
        assert_eq!(heuristic, "m0=sim;m1=nao", "a busca local fica ao lado");
    }

    #[test]
    fn falha_do_provedor_ou_resposta_incompleta_vira_none() {
        let candidates = vec![cand("stack", "Usar pnpm."), cand("cores", "Paleta azul.")];
        let settings = on(serve(500, "{}"));
        let db = db_with_settings(&settings);
        assert_eq!(select_with(&db, &settings, None, "objetivo", &candidates, &[], 5), None);
        let partial = r#"{"model":"m","answers":{"m0":{"type":"choice","choice":"sim","probabilities":{"sim":0.9}}}}"#;
        let settings = on(serve(200, partial));
        let db = db_with_settings(&settings);
        assert_eq!(select_with(&db, &settings, None, "objetivo", &candidates, &[], 5), None);
    }

    #[test]
    fn desligado_nao_consulta_nem_monta_briefing() {
        let mut settings = on("http://localhost:8000".into());
        settings.memory_relevance = false;
        let db = db_with_settings(&settings);
        let docs = vec![doc("e1", "stack", "Usar pnpm.")];
        assert_eq!(select(&db, "Corrigir o build", &[cand("stack", "Usar pnpm.")], &[], 5), None);
        assert_eq!(briefing(&db, "w1", "m1", "Corrigir o build", &docs), None);
        assert_eq!(log_rows(&db), 0);
    }

    #[test]
    fn o_briefing_mostra_so_as_escolhidas_e_diz_quantas_ficaram_de_fora() {
        let docs = vec![doc("e1", "stack", "Usar pnpm."), doc("e2", "cores", "Paleta azul."), doc("e3", "deploy", "Só pela master.")];
        let text = briefing_text(&docs, &[0], "m1", "Corrigir o build");
        assert!(text.contains("- [projeto] stack: Usar pnpm."));
        assert!(!text.contains("cores:"));
        assert!(text.contains("\n- (+2 outras memórias: use ags memory search)\nPara buscar mais:"));
        let all = briefing_text(&docs, &[0, 1, 2], "m1", "Corrigir o build");
        assert!(!all.contains("outras memórias: use"), "sem corte, sem a linha extra");
    }
}
