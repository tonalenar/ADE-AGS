//! Os motores, a retomada e o pool de contas na bancada (`bancada.rs`): roteiros com falhas tocados pelos
//! mapeadores de verdade, sem processo, sem cota e sem relógio. E o replay de protocolo (`replay_protocolo.rs`).

use std::cell::RefCell;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::bancada::{abrir, conferir, rodar, simular, tocar, Espera, Evento, Passo, Protocolo, Roteiro, Saida, PRAZO_PEDIDO_MS};
use super::pool::{decide, move_account, reset_at, Decision, Input, Mode};
use super::resume::{open_resuming, Opened, ResumeFailure, RETRY_PAUSES};
use crate::runs::failure::FailureKind;

const PROTOCOLOS: [Protocolo; 3] = [Protocolo::ClaudeStream, Protocolo::CodexAppServer, Protocolo::Acp];

fn sem_placeholder(s: &str) -> String {
    s.to_string()
}

// ── O fake de agente ──────────────────────────────────────────────────────

mod fake {
    use super::*;

    #[test]
    fn o_mesmo_roteiro_vira_o_mesmo_turno_nos_tres_protocolos() {
        for protocolo in PROTOCOLOS {
            let r = simular(&Roteiro::new(protocolo, vec![
                Passo::Sessao { id: "s1".into() },
                Passo::Texto { texto: "Pronto, rodei os testes.".into(), pedacos: 2 },
                Passo::Ferramenta { nome: "Bash".into(), entrada: json!({ "command": "cargo test" }), saida: "ok".into(), erro: false },
                Passo::Fim,
            ])).unwrap();
            assert_eq!(r.sessao(), Some("s1"), "{protocolo:?}");
            assert_eq!(r.ferramentas(), ["Bash:done"], "{protocolo:?}");
            assert!(r.texto().contains("Pronto, rodei os testes."), "{protocolo:?}: {}", r.texto());
            assert!(!r.deltas.is_empty(), "{protocolo:?}: os pedaços vão à janela");
            let fim = r.fim.as_ref().expect("o turno acabou");
            assert!(!fim.interrupted && fim.error.is_none(), "{protocolo:?}");
        }
    }

    #[test]
    fn os_pedacos_e_o_texto_final_tem_o_mesmo_id() {
        for protocolo in PROTOCOLOS {
            let r = simular(&Roteiro::new(protocolo, vec![Passo::Sessao { id: "s".into() }, Passo::Texto { texto: "abcdef".into(), pedacos: 3 }, Passo::Fim])).unwrap();
            let fala = r.itens.iter().find(|i| i.text.as_deref() == Some("abcdef")).expect("o texto fecha inteiro");
            assert!(r.deltas.iter().all(|(id, _)| *id == fala.id), "{protocolo:?}: {:?} vs {}", r.deltas, fala.id);
            assert_eq!(r.deltas.iter().map(|(_, d)| d.as_str()).collect::<String>(), "abcdef", "{protocolo:?}");
        }
    }

    #[test]
    fn a_linha_cortada_e_pulada_e_o_turno_segue() {
        for protocolo in PROTOCOLOS {
            let r = simular(&Roteiro::new(protocolo, vec![Passo::Sessao { id: "s".into() }, Passo::JsonMalformado, Passo::Texto { texto: "segui".into(), pedacos: 0 }, Passo::Fim])).unwrap();
            assert_eq!(r.ignoradas, 1, "{protocolo:?}");
            assert!(r.texto().contains("segui"), "{protocolo:?}");
            assert!(r.fim.is_some(), "{protocolo:?}");
        }
    }

    #[test]
    fn a_queda_no_meio_do_turno_vira_erro_com_o_motivo_do_stderr() {
        for protocolo in PROTOCOLOS {
            let r = simular(&Roteiro::new(protocolo, vec![
                Passo::Sessao { id: "s".into() },
                Passo::Aprovacao { comando: "rm -rf x".into() },
                Passo::Desconecta { stderr: Some("warning: depreciado\npanic: sem memória\nwarn: tchau".into()) },
            ])).unwrap();
            assert!(r.caiu, "{protocolo:?}");
            // Achado da bancada: o Codex guarda o stderr só no log, e a queda dele chega à tela sem o motivo.
            let motivo = if protocolo == Protocolo::CodexAppServer { "O processo do Codex fechou no meio do turno" } else { "panic: sem memória" };
            assert_eq!(r.erro(), Some(motivo), "{protocolo:?}: o aviso não vira o motivo");
            assert_eq!(r.pedidos.len(), 1, "{protocolo:?}");
        }
        let sem_stderr = simular(&Roteiro::new(Protocolo::ClaudeStream, vec![Passo::Sessao { id: "s".into() }, Passo::Desconecta { stderr: None }])).unwrap();
        assert_eq!(sem_stderr.erro(), Some("O processo do Claude fechou no meio do turno"));
    }

    #[test]
    fn aprovacao_e_pergunta_viram_pedidos_a_pessoa() {
        for protocolo in [Protocolo::ClaudeStream, Protocolo::CodexAppServer] {
            let r = simular(&Roteiro::new(protocolo, vec![
                Passo::Sessao { id: "s".into() },
                Passo::Aprovacao { comando: "git push --force".into() },
                Passo::Pergunta { pergunta: "Sigo?".into(), opcoes: vec!["Sim".into(), "Não".into()] },
            ])).unwrap();
            let kinds: Vec<&str> = r.pedidos.iter().map(|p| p.kind.as_str()).collect();
            assert_eq!(kinds, ["command", "question"], "{protocolo:?}");
            assert_eq!(r.pedidos[0].title, "git push --force", "{protocolo:?}");
        }
        let acp = simular(&Roteiro::new(Protocolo::Acp, vec![Passo::Sessao { id: "s".into() }, Passo::Aprovacao { comando: "git push --force".into() }])).unwrap();
        assert_eq!((acp.pedidos[0].kind.as_str(), acp.pedidos[0].title.as_str()), ("command", "git push --force"));
        assert!(tocar(&Roteiro::new(Protocolo::Acp, vec![Passo::Pergunta { pergunta: "?".into(), opcoes: vec![] }])).is_err(), "o ACP não pergunta");
    }

    #[test]
    fn interrupcao_nao_e_erro_e_max_tokens_e_so_no_acp_e_no_codex() {
        for protocolo in PROTOCOLOS {
            let r = simular(&Roteiro::new(protocolo, vec![Passo::Sessao { id: "s".into() }, Passo::Interrompido])).unwrap();
            let fim = r.fim.unwrap();
            assert!(fim.interrupted && fim.error.is_none(), "{protocolo:?}: {fim:?}");
        }
        let max = |p| simular(&Roteiro::new(p, vec![Passo::Sessao { id: "s".into() }, Passo::MaxTokens])).unwrap();
        assert!(max(Protocolo::Acp).erro().is_some_and(|e| e.contains("limite de tokens")));
        assert!(max(Protocolo::CodexAppServer).erro().is_some_and(|e| e.contains("max_output_tokens")));
        // Achado da bancada: o `claude_map` não lê o `stop_reason` da mensagem; um turno cortado no limite de tokens
        // acaba como "ok" na timeline. Registrado aqui para quem corrigir mudar este teste.
        assert_eq!(max(Protocolo::ClaudeStream).fim.unwrap().error, None);
    }

    #[test]
    fn o_silencio_so_anda_o_relogio_falso() {
        let r = simular(&Roteiro::new(Protocolo::CodexAppServer, vec![
            Passo::Sessao { id: "s".into() },
            Passo::Texto { texto: "antes".into(), pedacos: 0 },
            Passo::Stall { ms: 9 * 60_000 },
            Passo::Texto { texto: "depois".into(), pedacos: 0 },
        ])).unwrap();
        assert!(r.silencio_max_ms >= 9 * 60_000);
        assert!(r.fim.is_none(), "o turno ainda está aberto: é o que o Vigia vê como parado");
        let carimbos: Vec<i64> = r.itens.iter().filter_map(|i| i.at).collect();
        assert!(carimbos[1] - carimbos[0] >= 9 * 60_000, "os carimbos são do relógio falso: {carimbos:?}");
    }

    #[test]
    fn o_modo_aleatorio_e_reproduzivel_pela_semente() {
        for protocolo in PROTOCOLOS {
            assert_eq!(Roteiro::aleatorio(protocolo, 7, 8), Roteiro::aleatorio(protocolo, 7, 8));
            assert_ne!(Roteiro::aleatorio(protocolo, 7, 8), Roteiro::aleatorio(protocolo, 8, 8));
        }
    }

    /// Propriedades que valem para qualquer roteiro. Uma falha diz a semente; `BANCADA_SEED=<n>` roda só ela.
    #[test]
    fn roteiros_sorteados_nunca_quebram_o_motor() {
        let sementes: Vec<u64> = match std::env::var("BANCADA_SEED").ok().and_then(|s| s.parse().ok()) {
            Some(seed) => vec![seed],
            None => (0..300).collect(),
        };
        for protocolo in PROTOCOLOS {
            for &seed in &sementes {
                let roteiro = Roteiro::aleatorio(protocolo, seed, 10);
                let saidas = tocar(&roteiro).unwrap_or_else(|e| panic!("{protocolo:?} semente {seed}: {e}"));
                let r = super::super::bancada::rodar(protocolo, &saidas);
                let ctx = format!("{protocolo:?} semente {seed}: {roteiro:?}");
                let conta = |f: fn(&Passo) -> bool| roteiro.passos.iter().filter(|p| f(p)).count();
                assert_eq!(r.sessao(), Some(format!("sessao-{seed}").as_str()), "{ctx}");
                assert_eq!(r.ignoradas, conta(|p| matches!(p, Passo::JsonMalformado)), "{ctx}");
                assert_eq!(r.pedidos.len(), conta(|p| matches!(p, Passo::Aprovacao { .. } | Passo::Pergunta { .. })), "{ctx}");
                let mut ids: Vec<&str> = r.itens.iter().map(|i| i.id.as_str()).collect();
                ids.sort();
                ids.dedup();
                assert_eq!(ids.len(), r.itens.len(), "{ctx}: um item não pode aparecer duas vezes");
                match roteiro.passos.last() {
                    Some(Passo::Cota { .. }) => assert_eq!(r.classe_para_o_pool(), Some(FailureKind::RateLimited), "{ctx}"),
                    Some(Passo::Interrompido) => assert_eq!(r.classe_para_o_pool(), None, "{ctx}: parar não troca de conta"),
                    // O Codex só abre o turno com o primeiro item: cair antes dele não é turno perdido.
                    Some(Passo::Desconecta { .. }) if protocolo == Protocolo::CodexAppServer && !abriu_turno(&roteiro) => assert!(!r.caiu && r.fim.is_none(), "{ctx}"),
                    Some(Passo::Desconecta { .. }) => assert!(r.caiu, "{ctx}"),
                    Some(Passo::Fim) => assert!(r.fim.as_ref().is_some_and(|f| f.error.is_none()), "{ctx}"),
                    _ => {}
                }
            }
        }
    }
}

fn abriu_turno(roteiro: &Roteiro) -> bool {
    roteiro.passos.iter().skip(1).any(|p| !matches!(p, Passo::Stall { .. } | Passo::JsonMalformado | Passo::Desconecta { .. }))
}

// ── Roteiros em fixture (`conversa/fixtures/roteiros/*.json`) ─────────────────

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoteiroFixture {
    id: String,
    titulo: String,
    roteiro: Roteiro,
    espera: Espera,
}

#[test]
fn os_roteiros_das_fixtures_cumprem_o_que_prometem() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/conversa/fixtures/roteiros");
    let mut vistos = 0;
    let mut falhas = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let texto = std::fs::read_to_string(&path).unwrap();
        let f: RoteiroFixture = serde_json::from_str(&texto).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(path.file_stem().unwrap().to_string_lossy(), f.id, "o nome do arquivo é o id");
        assert!(!f.titulo.trim().is_empty());
        let r = simular(&f.roteiro).unwrap_or_else(|e| panic!("{}: {e}", f.id));
        falhas.extend(conferir(&f.espera, &r, f.roteiro.protocolo, &sem_placeholder).into_iter().map(|e| format!("{}: {e}", f.id)));
        vistos += 1;
    }
    assert!(vistos >= 3, "as fixtures sumiram de {}", dir.display());
    assert!(falhas.is_empty(), "{}", falhas.join("\n"));
}

#[test]
fn uma_chave_errada_na_espera_nao_passa_calada() {
    assert!(serde_json::from_value::<Espera>(json!({ "fim": "ok", "clase": "rate_limited" })).is_err());
    assert!(serde_json::from_value::<Passo>(json!({ "passo": "stall", "segundos": 3 })).is_err());
}

/// B2 e B4: o snapshot e a espera passam a afirmar o tipo do item, o pedido que sobrou e (ainda vazio
/// neste passo) o filho. O cancelamento do próprio agente tira o pedido dos pendentes sem apagá-lo da lista.
#[test]
fn o_snapshot_afirma_o_tipo_do_item_e_o_pedido_que_sobra() {
    let uso = json!({ "type": "assistant", "message": { "id": "msg_1", "role": "assistant",
        "usage": { "input_tokens": 4, "output_tokens": 6 },
        "content": [{ "type": "text", "text": "Vou pedir." }] } });
    let pedido = json!({ "type": "control_request", "request_id": "req_1", "request": {
        "subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "toolu_2", "input": { "command": "cargo test" },
    } });
    let linhas = |extra: Vec<Value>| {
        let mut eventos = vec![
            json!({ "type": "system", "subtype": "init", "session_id": "s1" }),
            uso.clone(),
            pedido.clone(),
        ];
        eventos.extend(extra);
        let saidas: Vec<Saida> = eventos.into_iter().enumerate().map(|(i, v)| Saida { at_ms: i as u64 * 10, evento: Evento::Linha(v.to_string()) }).collect();
        rodar(Protocolo::ClaudeStream, &saidas)
    };
    let aberto = linhas(vec![]);
    let espera = Espera {
        tipos: Some(vec!["usage".into(), "assistant".into()]),
        filhos: Some(vec![]),
        pedidos_pendentes: Some(vec!["command".into()]),
        pedidos: Some(vec!["command".into()]),
        ..Espera::default()
    };
    let falhas = conferir(&espera, &aberto, Protocolo::ClaudeStream, &sem_placeholder);
    assert!(falhas.is_empty(), "{falhas:?}");
    let snap = super::replay_protocolo::snapshot(&aberto);
    assert_eq!(snap["tipos"], json!(["usage", "assistant"]));
    assert_eq!(snap["filhos"], json!([]));
    assert_eq!(snap["pedidosPendentes"], json!([{ "kind": "command", "title": "cargo test" }]));
    assert_eq!(snap["pedidos"], snap["pedidosPendentes"], "sem cancelamento, o pedido ainda está pendente");

    let cancelado = linhas(vec![json!({ "type": "control_cancel_request", "request_id": "req_1" })]);
    let espera_cancelado = Espera { pedidos: Some(vec!["command".into()]), pedidos_pendentes: Some(vec![]), ..Espera::default() };
    let falhas = conferir(&espera_cancelado, &cancelado, Protocolo::ClaudeStream, &sem_placeholder);
    assert!(falhas.is_empty(), "{falhas:?}");
    assert!(super::replay_protocolo::snapshot(&cancelado)["pedidosPendentes"].as_array().unwrap().is_empty());

    let errado = Espera { pedidos_pendentes: Some(vec![]), ..espera.clone() };
    let falhas = conferir(&errado, &aberto, Protocolo::ClaudeStream, &sem_placeholder);
    assert!(falhas.iter().any(|e| e.contains("pedidosPendentes")), "{falhas:?}");
}

/// B3: a tarefa e o que o subagente faz iam para o chão. Ficam em `filhos`, fora da timeline do pai,
/// e o filho pode aparecer antes de o turno do pai acabar.
#[test]
fn o_motor_guarda_a_tarefa_e_o_item_do_subagente() {
    let eventos = vec![
        json!({ "type": "system", "subtype": "init", "session_id": "s1" }),
        json!({ "type": "system", "subtype": "task_started", "task_id": "af9", "tool_use_id": "toolu_agent",
            "description": "Responder com ok", "task_type": "local_agent", "prompt": "Responda só ok." }),
        json!({ "type": "assistant", "parent_tool_use_id": "toolu_agent",
            "message": { "id": "msg_sub", "content": [{ "type": "text", "text": "ok" }] } }),
        json!({ "type": "assistant", "message": { "id": "msg_pai", "content": [{ "type": "text", "text": "o pai segue" }] } }),
    ];
    let saidas: Vec<Saida> = eventos.into_iter().enumerate().map(|(i, v)| Saida { at_ms: i as u64 * 10, evento: Evento::Linha(v.to_string()) }).collect();
    let r = rodar(Protocolo::ClaudeStream, &saidas);
    assert!(r.fim.is_none(), "o turno do pai continua aberto");
    assert_eq!(r.texto(), "o pai segue", "a fala do filho não entra na timeline: {}", r.texto());
    assert_eq!(r.filhos_compactos(), ["task:af9:started", "subitem:toolu_agent:assistant"]);
    let espera = Espera { filhos: Some(vec!["task:af9:started".into(), "subitem:toolu_agent:assistant".into()]), tipos: Some(vec!["assistant".into()]), ..Espera::default() };
    let falhas = conferir(&espera, &r, Protocolo::ClaudeStream, &sem_placeholder);
    assert!(falhas.is_empty(), "{falhas:?}");
    let snap = super::replay_protocolo::snapshot(&r);
    assert_eq!(snap["filhos"][0]["tipo"], "task");
    assert_eq!(snap["filhos"][0]["task"]["taskId"], "af9");
    assert_eq!(snap["filhos"][1]["parent"], "toolu_agent");
    assert_eq!(snap["filhos"][1]["item"]["text"], "ok");
    assert!(snap["itens"].as_array().unwrap().iter().all(|i| i["text"] != "ok"));
}

/// B1, parte do Antigravity: o leitor percorre o fluxo sem o prazo de abertura dos outros motores.
/// As duas linhas são o mínimo que o mapeador já aceita nos testes dele. Não descrevem um turno real.
#[test]
fn o_agy_le_o_fluxo_sem_prazo_de_silencio() {
    let init = json!({ "event": "init", "conversation_id": "cv-leitura" });
    let result = json!({ "event": "result", "result": { "status": "SUCCESS", "response": "lido", "conversation_id": "cv-leitura" } });
    let saidas = vec![
        Saida { at_ms: 0, evento: Evento::Linha(init.to_string()) },
        Saida { at_ms: PRAZO_PEDIDO_MS + 5_000, evento: Evento::Linha(result.to_string()) },
    ];
    let r = rodar(Protocolo::AgyStream, &saidas);
    assert_eq!(r.sessao(), Some("cv-leitura"));
    assert_eq!(r.texto(), "lido");
    assert!(r.fim.as_ref().is_some_and(|f| f.error.is_none() && !f.interrupted), "{:?}", r.fim);
    assert!(r.silencio_max_ms > PRAZO_PEDIDO_MS, "o buraco de tempo não fecha o turno");
    assert!(tocar(&Roteiro::new(Protocolo::AgyStream, vec![Passo::Sessao { id: "x".into() }])).is_err(), "o roteiro não sintetiza este protocolo");
    assert_eq!(serde_json::from_value::<Protocolo>(json!("agy-stream")).unwrap(), Protocolo::AgyStream);
}

/// B6: o `read_turn` do Cursor, com o relógio do transcript. A linha cujo `atMs` passa de `quiet_after`
/// não entra. Não é um turno do provider: o formato é o mínimo que o mapeador já lê nos testes dele.
#[test]
fn o_cursor_cala_quando_o_proximo_instante_passa_do_prazo() {
    use crate::conversa::cursor_map::QUIET_AFTER_SPEECH;
    let sid = "sessao-leitura";
    let init = json!({ "type": "system", "subtype": "init", "session_id": sid });
    let fala = |texto: &str| json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": texto }] }, "session_id": sid, "timestamp_ms": 1 });
    let prazo = u64::try_from(QUIET_AFTER_SPEECH.as_millis()).unwrap();
    let calado = vec![
        Saida { at_ms: 0, evento: Evento::Linha(init.to_string()) },
        Saida { at_ms: 10, evento: Evento::Linha(fala("cedo").to_string()) },
        Saida { at_ms: 10 + prazo + 1, evento: Evento::Linha(fala("tarde demais").to_string()) },
    ];
    let r = rodar(Protocolo::CursorStream, &calado);
    assert_eq!(r.sessao(), Some(sid));
    assert_eq!(r.texto(), "cedo");
    assert!(!r.caiu && r.fim.as_ref().is_some_and(|f| f.error.is_none()), "a fala já tinha vindo: {:?}", r.fim);
    assert!(r.silencio_max_ms > prazo);

    let dentro = vec![
        Saida { at_ms: 0, evento: Evento::Linha(init.to_string()) },
        Saida { at_ms: 10, evento: Evento::Linha(fala("um").to_string()) },
        Saida { at_ms: 10 + prazo, evento: Evento::Linha(fala("dois").to_string()) },
    ];
    let r = rodar(Protocolo::CursorStream, &dentro);
    assert_eq!(r.texto(), "umdois", "no limite do prazo a linha ainda entra: {}", r.texto());

    let ferramenta = json!({ "type": "tool_call", "subtype": "started", "call_id": "sh1", "session_id": sid,
        "tool_call": { "shellToolCall": { "args": { "command": "echo oi" } } } });
    let pronta = json!({ "type": "tool_call", "subtype": "completed", "call_id": "sh1", "session_id": sid, "tool_call": {
        "shellToolCall": { "args": { "command": "echo oi" }, "result": { "success": { "stdout": "oi", "exitCode": 0 } } } } });
    let longa = vec![
        Saida { at_ms: 0, evento: Evento::Linha(init.to_string()) },
        Saida { at_ms: 10, evento: Evento::Linha(ferramenta.to_string()) },
        Saida { at_ms: 10 + prazo + 1, evento: Evento::Linha(pronta.to_string()) },
    ];
    let r = rodar(Protocolo::CursorStream, &longa);
    assert_eq!(r.ferramentas(), ["Bash:done"], "ferramenta rodando não tem prazo: {:?}", r.ferramentas());
    assert!(tocar(&Roteiro::new(Protocolo::CursorStream, vec![Passo::Sessao { id: "x".into() }])).is_err());
}

// ── A retomada (`resume.rs`) com sessões abertas pela bancada ─────────────────

/// `open_resuming` com cada tentativa de retomada tocando o roteiro seguinte; a sessão nova é outro roteiro.
fn retomar(protocolo: Protocolo, tentativas: Vec<Vec<Passo>>, nova: Vec<Passo>) -> (Result<Opened<String>, String>, usize, Vec<Duration>) {
    let tentativas = RefCell::new(tentativas.into_iter());
    let novas = RefCell::new(0usize);
    let pausas = RefCell::new(Vec::new());
    let out = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(open_resuming(
        || {
            let passos = tentativas.borrow_mut().next().expect("tentativa a mais");
            async move { abrir(&Roteiro::new(protocolo, passos)) }
        },
        || {
            *novas.borrow_mut() += 1;
            let r = abrir(&Roteiro::new(protocolo, nova.clone())).map_err(ResumeFailure::into_message);
            async move { r }
        },
        |wait| {
            pausas.borrow_mut().push(wait);
            async {}
        },
    ));
    (out, *novas.borrow(), pausas.into_inner())
}

mod retomada {
    use super::*;

    fn sessao(id: &str) -> Vec<Passo> {
        vec![Passo::Sessao { id: id.into() }]
    }

    #[test]
    fn a_thread_que_o_codex_recusa_abre_outra_e_avisa() {
        let (out, novas, pausas) = retomar(Protocolo::CodexAppServer, vec![vec![Passo::Recusa { mensagem: "no rollout found for thread id thr_9".into() }]], sessao("thr_nova"));
        assert_eq!(out, Ok(Opened { session: "thr_nova".into(), lost: Some("no rollout found for thread id thr_9".into()) }));
        assert_eq!((novas, pausas.len()), (1, 0), "a recusa do servidor é `Gone`: sem retentativa");
    }

    #[test]
    fn o_claude_que_nao_acha_a_sessao_abre_outra() {
        let (out, novas, _) = retomar(Protocolo::ClaudeStream, vec![vec![Passo::Recusa { mensagem: "No conversation found with session ID: abc".into() }]], sessao("nova"));
        assert_eq!(out.unwrap().lost.as_deref(), Some("No conversation found with session ID: abc"));
        assert_eq!(novas, 1);
    }

    #[test]
    fn o_silencio_na_abertura_e_prazo_e_nao_troca_a_sessao() {
        for protocolo in PROTOCOLOS {
            let (out, novas, _) = retomar(protocolo, vec![vec![Passo::Stall { ms: 61_000 }, Passo::Sessao { id: "tarde".into() }]], sessao("nova"));
            let erro = out.unwrap_err();
            assert!(erro.contains("Ela foi mantida") && erro.contains("não respondeu"), "{protocolo:?}: {erro}");
            assert_eq!(novas, 0, "{protocolo:?}: a sessão pode existir");
        }
        // 59 s ainda está no prazo.
        let (out, _, _) = retomar(Protocolo::Acp, vec![vec![Passo::Stall { ms: 59_000 }, Passo::Sessao { id: "a-tempo".into() }]], sessao("nova"));
        assert_eq!(out.unwrap(), Opened { session: "a-tempo".into(), lost: None });
    }

    #[test]
    fn o_processo_que_cai_ao_abrir_tenta_de_novo_e_nao_esquece_se_voltar() {
        for protocolo in PROTOCOLOS {
            let caiu = vec![Passo::Desconecta { stderr: None }];
            let (out, novas, pausas) = retomar(protocolo, vec![caiu.clone(), sessao("antiga")], sessao("nova"));
            assert_eq!(out, Ok(Opened { session: "antiga".into(), lost: None }), "{protocolo:?}");
            assert_eq!((novas, pausas), (0, vec![RETRY_PAUSES[0]]), "{protocolo:?}");
            let (out, novas, pausas) = retomar(protocolo, vec![caiu.clone(), caiu.clone(), caiu], sessao("nova"));
            assert_eq!(out.unwrap().lost.as_deref(), Some(format!("O processo do {} fechou", match protocolo {
                Protocolo::ClaudeStream => "Claude",
                Protocolo::CodexAppServer => "Codex",
                Protocolo::Acp => "OpenCode",
                Protocolo::AgyStream => "Antigravity",
                Protocolo::CursorStream => "Cursor",
            }).as_str()), "{protocolo:?}");
            assert_eq!((novas, pausas), (1, RETRY_PAUSES.to_vec()), "{protocolo:?}");
        }
    }
}

// ── O pool de contas (`pool.rs`) com o erro que o motor produziu ──────────────

mod pool {
    use super::*;

    /// 11:34 locais (UTC-3), como em `pool_test.rs`.
    const AGORA: i64 = 1_793_543_640;
    const FUSO: i64 = -3 * 3600;
    const COTA: &str = "You've hit your limit · resets 3pm (America/Sao_Paulo)";

    fn turno_que_esgota(protocolo: Protocolo, sessao: &str) -> super::super::bancada::Resultado {
        simular(&Roteiro::new(protocolo, vec![
            Passo::Sessao { id: sessao.into() },
            Passo::Texto { texto: "trabalhando".into(), pedacos: 0 },
            Passo::Cota { mensagem: COTA.into() },
        ])).unwrap()
    }

    fn decisao(mode: Mode, kind: FailureKind, switched_this_turn: bool, history: &[i64]) -> Decision {
        decide(Input { mode, kind, bound_to_pool: true, switched_this_turn, history, now: AGORA, next: Ok(Some("b".into())) })
    }

    #[test]
    fn a_cota_de_qualquer_motor_chega_ao_pool_como_limite_com_a_hora_da_renovacao() {
        for protocolo in PROTOCOLOS {
            let r = turno_que_esgota(protocolo, "s");
            let erro = r.erro().unwrap_or_else(|| panic!("{protocolo:?}: o turno falhou"));
            assert_eq!(r.classe_para_o_pool(), Some(FailureKind::RateLimited), "{protocolo:?}: {erro}");
            assert_eq!(reset_at(erro, AGORA, FUSO), AGORA + 3 * 3600 + 26 * 60, "{protocolo:?}: renova às 15:00 locais");
            assert_eq!(decisao(Mode::Auto, FailureKind::RateLimited, false, &[]), Decision::Switch { to: Some("b".into()) });
        }
    }

    #[test]
    fn parar_ou_cair_nao_troca_de_conta() {
        let parado = simular(&Roteiro::new(Protocolo::ClaudeStream, vec![Passo::Sessao { id: "s".into() }, Passo::Interrompido])).unwrap();
        assert_eq!(parado.classe_para_o_pool(), None);
        let caiu = simular(&Roteiro::new(Protocolo::ClaudeStream, vec![Passo::Sessao { id: "s".into() }, Passo::Desconecta { stderr: Some("Segmentation fault".into()) }])).unwrap();
        let kind = caiu.classe_para_o_pool().unwrap();
        assert_eq!(decisao(Mode::Auto, kind, false, &[]), Decision::Skip, "só o limite troca de conta");
    }

    #[test]
    fn a_troca_abre_sessao_nova_na_outra_conta_e_a_segunda_cota_nao_encadeia() {
        let db = {
            let conn = crate::database::test_db();
            super::super::store::migrate(&conn).unwrap();
            let tuning = super::super::store::Tuning { model: None, effort: None, access: "ask".into() };
            super::super::store::insert_thread(&conn, "t1", "claude-code", "/tmp/p", "Título", &tuning, Some("a"), 1).unwrap();
            std::sync::Arc::new(std::sync::Mutex::new(conn))
        };
        // 1º turno na conta A: a sessão é gravada, e o turno esgota.
        let primeiro = turno_que_esgota(Protocolo::ClaudeStream, "sessao-da-conta-a");
        {
            let conn = db.lock().unwrap();
            super::super::store::set_remote_id(&conn, "t1", primeiro.sessao().unwrap()).unwrap();
        }
        let kind = primeiro.classe_para_o_pool().unwrap();
        let Decision::Switch { to } = decisao(Mode::Auto, kind, false, &[]) else { panic!("devia trocar") };
        move_account(&db, "t1", &Some("a".into()), &to, reset_at(primeiro.erro().unwrap(), AGORA, FUSO), AGORA).unwrap();
        let row = super::super::api::thread(&db, "t1").unwrap();
        assert_eq!((row.account_id.as_deref(), row.remote_id.as_deref()), (Some("b"), None), "a conta B não retoma a sessão da A");

        // 2º turno, na conta B: sem `remote_id`, a conversa abre do zero (outra sessão) e esgota de novo logo depois.
        let segundo = turno_que_esgota(Protocolo::ClaudeStream, "sessao-da-conta-b");
        assert_ne!(segundo.sessao(), primeiro.sessao());
        let history = [AGORA];
        assert!(matches!(decisao(Mode::Auto, segundo.classe_para_o_pool().unwrap(), true, &history), Decision::Blocked(_)), "não encadeia trocas no mesmo turno");
        // Perguntar em vez de trocar: a mesma cota vira a pergunta.
        assert_eq!(decisao(Mode::Ask, FailureKind::RateLimited, false, &history), Decision::Ask { to: Some("b".into()) });
    }
}

// ── O replay de protocolo (`ade-replay` v2) ──────────────────────────────────

mod replay_protocolo {
    use serde_json::Value;

    use super::super::bancada::{self, Espera, Evento, Protocolo, Saida};

    use super::super::replay_protocolo::*;

    fn fixture(transcript: Value, protocol: &str) -> String {
        serde_json::json!({
            "format": "ade-replay", "version": 2, "kind": "protocolo", "id": "x", "agent": "claude-code", "protocol": protocol,
            "title": "t", "origin": { "kind": "synthesized", "basis": "teste" }, "transcript": transcript,
        }).to_string()
    }

    fn oraculo(checks: Value) -> Oraculo {
        ler_oraculo(&serde_json::json!({ "checks": checks }).to_string()).unwrap()
    }

    /// Todas as fixtures da pasta, no modo pedido (`ADE_REPLAY_MODE`). `refresh` regrava só o `expected` do
    /// `<id>.json`, e só se o oráculo passar.
    #[test]
    fn as_fixtures_de_protocolo_batem_com_o_oraculo_e_o_snapshot() {
        let modo = Modo::do_ambiente().unwrap();
        if modo == Modo::Record {
            return;
        }
        let pares = fixtures(&pasta()).unwrap();
        assert!(pares.len() >= 3, "as fixtures sumiram de {}", pasta().display());
        let mut falhas = Vec::new();
        for (arquivo, arquivo_oraculo) in pares {
            let texto = std::fs::read_to_string(&arquivo).unwrap();
            let resultado = (|| {
                let f = ler(&texto)?;
                if arquivo.file_stem().map(|s| s.to_string_lossy().into_owned()) != Some(f.id.clone()) {
                    return Err(format!("{}: o nome do arquivo é o id", arquivo.display()));
                }
                let o = std::fs::read_to_string(&arquivo_oraculo).map_err(|_| format!("{}: falta o oráculo {}", f.id, arquivo_oraculo.display()))?;
                let novo = tocar(&f, &ler_oraculo(&o)?)?;
                match modo {
                    Modo::Refresh => std::fs::write(&arquivo, com_snapshot(&texto, &novo)?).map_err(|e| e.to_string()),
                    _ => conferir_snapshot(&f, &novo),
                }
            })();
            if let Err(e) = resultado {
                falhas.push(e);
            }
        }
        assert!(falhas.is_empty(), "{}", falhas.join("\n\n"));
    }

    /// `ADE_REPLAY_MODE=record ADE_REPLAY_SOURCE=<.jsonl> ADE_REPLAY_ID=<id> ADE_REPLAY_PROTOCOL=<protocolo>
    /// [ADE_REPLAY_AGENT=…] [ADE_REPLAY_CWD=…]`: cria a fixture e um oráculo vazio (que reprova até ser escrito).
    #[test]
    fn gravar_fixture_de_protocolo() {
        if Modo::do_ambiente() != Ok(Modo::Record) {
            return;
        }
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("record precisa de {k}"));
        let id = var("ADE_REPLAY_ID");
        let jsonl = std::fs::read_to_string(var("ADE_REPLAY_SOURCE")).unwrap();
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok();
        let cwd = std::env::var("ADE_REPLAY_CWD").ok();
        let agent = std::env::var("ADE_REPLAY_AGENT").unwrap_or_else(|_| "claude-code".into());
        let texto = gravar(&id, &agent, &var("ADE_REPLAY_PROTOCOL"), &jsonl, cwd.as_deref(), home.as_deref()).unwrap();
        let destino = pasta().join(format!("{id}.json"));
        assert!(!destino.exists(), "{} já existe: apague antes de gravar de novo", destino.display());
        std::fs::write(&destino, texto).unwrap();
        let oraculo = pasta().join(format!("{id}.oracle.json"));
        if !oraculo.exists() {
            std::fs::write(oraculo, "{\n  \"checks\": []\n}\n").unwrap();
        }
    }

    #[test]
    fn os_placeholders_sao_tipados() {
        assert_eq!(expandir("{{session:2}} em {{cwd}}").unwrap(), format!("{} em {CWD}", session_id(2)));
        assert!(expandir("{{sesion:1}}").unwrap_err().contains("desconhecido"));
        assert!(expandir("{{session:0}}").is_err() && expandir("{{session}}").is_err() && expandir("{{cwd:1}}").is_err());
        assert_eq!(recolocar(&format!("{} {CWD}/a {HOME}", session_id(3)), 5), "{{session:3}} {{cwd}}/a {{home}}");
    }

    #[test]
    fn gravar_troca_uuids_e_caminhos_por_placeholders_e_recusa_segredo() {
        let a = "11111111-2222-3333-4444-555555555555";
        let b = "99999999-8888-7777-6666-555555555555";
        let jsonl = format!("{{\"session_id\":\"{a}\",\"cwd\":\"/Users/ton/p\"}}\n{{\"x\":\"{b}\",\"y\":\"{a}\",\"h\":\"/Users/ton/.claude\"}}\nnao-json\n");
        let texto = gravar("g", "claude-code", "claude-stream", &jsonl, Some("/Users/ton/p"), Some("/Users/ton")).unwrap();
        assert!(!texto.contains(a) && !texto.contains("/Users/ton"), "{texto}");
        assert!(texto.contains("{{session:1}}") && texto.contains("{{session:2}}") && texto.contains("{{cwd}}") && texto.contains("{{home}}/.claude"));
        assert!(texto.contains("\"raw\": \"nao-json\""));
        let f = ler(&texto).unwrap();
        assert_eq!(f.transcript.len(), 3);
        assert!(gravar("g", "claude-code", "claude-stream", "{\"x\":\"Authorization: Bearer abc.def.ghi\"}", None, None).is_err());
    }

    #[test]
    fn o_guard_recusa_ferramenta_desconhecida() {
        let texto = fixture(serde_json::json!([
            { "atMs": 0, "out": { "type": "system", "subtype": "init", "session_id": "{{session:1}}" } },
            { "atMs": 10, "out": { "type": "assistant", "message": { "id": "m", "content": [{ "type": "tool_use", "id": "t1", "name": "FerramentaNova", "input": {} }] } } },
        ]), "claude-stream");
        let f = ler(&texto).unwrap();
        let erro = tocar(&f, &oraculo(serde_json::json!([{ "label": "abre", "expect": { "sessao": "{{session:1}}" } }]))).unwrap_err();
        assert!(erro.contains("FerramentaNova") && erro.contains("não conhece"), "{erro}");
    }

    /// B5: a lista é por protocolo. Os três primeiros continuam recusando qualquer `Other`.
    /// agy e Cursor só deixam passar o nome da lista; o resto derruba a fixture. Os frames são o
    /// mínimo para o mapeador emitir o item. Não afirmam o que o provider manda.
    #[test]
    fn a_lista_de_ferramentas_e_por_protocolo_e_nao_afrouxa_os_tres() {
        let rodar = |protocol: &str, transcript: Value| {
            let f = ler(&fixture(transcript, protocol)).unwrap();
            tocar(&f, &oraculo(serde_json::json!([{ "label": "le", "expect": {} }])))
        };
        let codex = rodar("codex-app-server", serde_json::json!([
            { "atMs": 0, "out": { "method": "item/completed", "params": { "item": { "id": "c", "type": "mcpToolCall", "server": "ags", "tool": "x", "status": "completed" } } } },
        ]));
        assert!(codex.unwrap_err().contains("ags.x"), "o Codex continua recusando Other");
        let acp = rodar("acp", serde_json::json!([
            { "atMs": 0, "out": { "jsonrpc": "2.0", "method": "session/update", "params": { "update": {
                "sessionUpdate": "tool_call", "toolCallId": "c", "title": "FerramentaNova", "kind": "other", "status": "completed"
            } } } },
        ]));
        assert!(acp.unwrap_err().contains("FerramentaNova"), "o ACP continua recusando Other");
        let filho = rodar("claude-stream", serde_json::json!([
            { "atMs": 0, "out": { "type": "assistant", "parent_tool_use_id": "pai", "message": { "id": "m", "content": [
                { "type": "tool_use", "id": "t", "name": "FerramentaNova", "input": {} }
            ] } } },
        ]));
        assert!(filho.unwrap_err().contains("FerramentaNova"), "o filho não fura o guard");

        let negado = rodar("agy-stream", serde_json::json!([
            { "atMs": 0, "out": { "event": "result", "result": { "status": "SUCCESS", "denied_actions": ["git push"] } } },
        ]));
        assert!(negado.is_ok(), "denied está na lista do agy: {negado:?}");
        let solto = rodar("agy-stream", serde_json::json!([
            { "atMs": 0, "out": { "event": "step_update", "step_update": { "step_index": 1, "state": "DONE", "step_type": "xyzzy", "tool_name": "xyzzy" } } },
        ]));
        assert!(solto.unwrap_err().contains("xyzzy"), "nome fora da lista do agy cai");

        let mcp = rodar("cursor-stream", serde_json::json!([
            { "atMs": 0, "out": { "type": "tool_call", "subtype": "started", "call_id": "c", "session_id": "s",
                "tool_call": { "mcpToolCall": { "args": { "toolName": "mcp" } } } } },
        ]));
        assert!(mcp.is_ok(), "mcp está na lista do Cursor só para exercitar o guard: {mcp:?}");
        let outro = rodar("cursor-stream", serde_json::json!([
            { "atMs": 0, "out": { "type": "tool_call", "subtype": "started", "call_id": "c", "session_id": "s",
                "tool_call": { "mcpToolCall": { "args": { "toolName": "xyzzy" } } } } },
        ]));
        let erro = outro.unwrap_err();
        assert!(erro.contains("xyzzy") && erro.contains("fora da lista"), "{erro}");
    }

    #[test]
    fn sem_oraculo_ou_com_formato_errado_nao_roda() {
        assert!(ler_oraculo("{\"checks\": []}").unwrap_err().contains("ao menos um"));
        assert!(ler_oraculo("{\"checks\": [{\"label\": \"x\", \"expect\": {\"fimm\": \"ok\"}}]}").is_err());
        let v1 = fixture(serde_json::json!([]), "acp").replace("\"version\":2", "\"version\":1");
        assert!(ler(&v1).is_err());
        let dois = fixture(serde_json::json!([{ "atMs": 0, "out": {}, "raw": "x" }]), "acp");
        assert!(ler(&dois).unwrap_err().contains("exatamente um"));
    }

    /// O ponto do oráculo: um mapeador que regrediu muda o snapshot, e o refresh gravaria a regressão como certa.
    /// Com o oráculo escrito à mão, o `tocar` falha antes de qualquer escrita.
    #[test]
    fn o_refresh_nao_aprova_uma_regressao() {
        let texto = fixture(serde_json::json!([
            { "atMs": 0, "out": { "type": "system", "subtype": "init", "session_id": "{{session:1}}" } },
            { "atMs": 10, "out": { "type": "result", "subtype": "success", "is_error": true, "result": "You've hit your limit" } },
        ]), "claude-stream");
        let f = ler(&texto).unwrap();
        let certo = oraculo(serde_json::json!([{ "label": "esgotou", "expect": { "fim": "erro", "classe": "rate_limited" } }]));
        assert!(tocar(&f, &certo).is_ok());
        // A "regressão": o oráculo diz uma coisa e o motor faz outra.
        let errado = oraculo(serde_json::json!([{ "label": "acabou bem", "expect": { "fim": "ok" } }]));
        let erro = tocar(&f, &errado).unwrap_err();
        assert!(erro.contains("o refresh não regrava"), "{erro}");
    }

    #[test]
    fn o_refresh_so_troca_o_expected() {
        let texto = fixture(serde_json::json!([]), "acp");
        let novo = com_snapshot(&texto, &serde_json::json!({ "sessao": null })).unwrap();
        let antes: Value = serde_json::from_str(&texto).unwrap();
        let mut depois: Value = serde_json::from_str(&novo).unwrap();
        assert_eq!(depois["expected"], serde_json::json!({ "sessao": null }));
        depois.as_object_mut().unwrap().remove("expected");
        assert_eq!(antes, depois);
    }

    fn gravada(id: &str) -> Value {
        let texto = std::fs::read_to_string(pasta().join(format!("{id}.json"))).unwrap();
        serde_json::from_str(&texto).unwrap()
    }

    fn outs(fixture: &Value) -> Vec<&Value> {
        fixture["transcript"].as_array().unwrap().iter().filter(|e| e.get("out").is_some()).map(|e| &e["out"]).collect()
    }

    /// Variante derivada: os eventos são sempre lidos de uma captura `recorded`; o teste só os corta ou move.
    /// O rótulo e `origem` tornam a proveniência revisável sem duplicar centenas de linhas de transcript.
    fn captura(id: &str) -> Vec<Saida> {
        let texto = std::fs::read_to_string(pasta().join(format!("{id}.json"))).unwrap();
        let fixture = ler(&texto).unwrap();
        assert_eq!(
            fixture.origin["kind"], "recorded",
            "{id} precisa ser captura real sanitizada"
        );
        super::super::replay_protocolo::saidas(&fixture)
    }

    fn quadro(saida: &Saida) -> Option<Value> {
        match &saida.evento {
            Evento::Linha(line) => serde_json::from_str(line).ok(),
            Evento::Fecha { .. } => None,
        }
    }

    fn mover(
        saidas: &mut Vec<Saida>,
        origem: impl Fn(&Value) -> bool,
        alvo: impl Fn(&Value) -> bool,
        depois: bool,
    ) {
        let index = |predicado: &dyn Fn(&Value) -> bool, frames: &[Saida]| {
            frames
                .iter()
                .position(|saida| quadro(saida).is_some_and(|out| predicado(&out)))
                .expect("frame da captura ausente")
        };
        let from = index(&origem, saidas);
        let moving = saidas.remove(from);
        let to = index(&alvo, saidas) + usize::from(depois);
        saidas.insert(to, moving);
    }

    fn oraculo_estado(protocolo: Protocolo, saidas: &[Saida], fim: &str, texto: Option<&str>) {
        let resultado = bancada::rodar(protocolo, saidas);
        let espera: Espera = serde_json::from_value(serde_json::json!({ "fim": fim })).unwrap();
        let falhas = bancada::conferir(&espera, &resultado, protocolo, &|s| expandir(s).unwrap());
        assert!(
            falhas.is_empty(),
            "oráculo derivado falhou: {falhas:?}; resultado={:?}",
            super::super::replay_protocolo::snapshot(&resultado)
        );
        if let Some(texto) = texto {
            let parcial = resultado.deltas.iter().map(|(_, delta)| delta.as_str()).collect::<String>();
            assert!(resultado.texto().contains(texto) || parcial.contains(texto), "texto esperado {texto:?}; timeline={:?}; deltas={parcial:?}", resultado.texto());
        }
    }

    fn ate_frame(mut saidas: Vec<Saida>, predicado: impl Fn(&Value) -> bool) -> Vec<Saida> {
        let index = saidas
            .iter()
            .position(|saida| quadro(saida).is_some_and(|out| predicado(&out)))
            .expect("frame da captura ausente");
        saidas.truncate(index + 1);
        saidas
    }

    fn sem_frame_final(saidas: Vec<Saida>, predicado: impl Fn(&Value) -> bool) -> Vec<Saida> {
        let index = saidas
            .iter()
            .position(|saida| quadro(saida).is_some_and(|out| predicado(&out)))
            .expect("frame final da captura ausente");
        saidas.into_iter().take(index).collect()
    }

    /// Variante derivada de `claude-feliz`: o `user` com resultado de ferramenta chega antes do `assistant`
    /// que anuncia `tool_use`. O oráculo do contrato exige que o turno termine e que a ferramenta feche.
    #[test]
    fn replay_derivado_claude_tool_result_fora_de_ordem() {
        let mut saidas = captura("claude-feliz");
        mover(
            &mut saidas,
            |out| out["type"] == "user",
            |out| {
                out["type"] == "assistant"
                    && out.pointer("/message/content/0/type")
                        == Some(&Value::String("tool_use".into()))
            },
            false,
        );
        // A transformação é só uma permutação dos frames reais de `claude-feliz`.
        oraculo_estado(Protocolo::ClaudeStream, &saidas, "ok", None);
        let resultado = bancada::rodar(Protocolo::ClaudeStream, &saidas);
        assert_eq!(resultado.ferramentas(), ["Read:done"]);
    }

    /// Variante derivada de `codex-feliz`: `turn/started` é movido para logo depois da resposta a `turn/start`.
    #[test]
    fn replay_derivado_codex_started_depois_da_resposta_turn_start() {
        let mut saidas = captura("codex-feliz");
        mover(
            &mut saidas,
            |out| out["method"] == "turn/started",
            |out| out["id"] == 3,
            true,
        );
        oraculo_estado(Protocolo::CodexAppServer, &saidas, "ok", Some("conteúdo"));
    }

    /// Variante derivada de `antigravity-feliz`: o DONE da ferramenta chega depois do texto de resposta.
    #[test]
    fn replay_derivado_antigravity_ferramenta_depois_do_texto() {
        let mut saidas = captura("antigravity-feliz");
        mover(
            &mut saidas,
            |out| {
                out["event"] == "step_update"
                    && out.pointer("/step_update/step_index") == Some(&Value::from(2))
                    && out.pointer("/step_update/state") == Some(&Value::String("DONE".into()))
            },
            |out| {
                out["event"] == "step_update"
                    && out.pointer("/step_update/step_index") == Some(&Value::from(3))
                    && out.pointer("/step_update/state") == Some(&Value::String("ACTIVE".into()))
            },
            true,
        );
        oraculo_estado(
            Protocolo::AgyStream,
            &saidas,
            "ok",
            Some("conteúdo do arquivo"),
        );
    }

    /// Variante derivada de `cursor-feliz`: o fim da leitura chega após a resposta textual final.
    #[test]
    fn replay_derivado_cursor_ferramenta_depois_do_texto() {
        let mut saidas = captura("cursor-feliz");
        mover(
            &mut saidas,
            |out| out["type"] == "tool_call" && out["subtype"] == "completed",
            |out| {
                out["type"] == "assistant"
                    && out
                        .pointer("/message/content/0/text")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s.starts_with("O arquivo `teste.txt` contém"))
            },
            true,
        );
        oraculo_estado(Protocolo::CursorStream, &saidas, "ok", Some("O arquivo"));
    }

    /// Cortes derivados: cada prefixo termina no meio de uma ferramenta (Claude/Cursor) ou texto (Codex/agy).
    #[test]
    fn replay_derivado_streams_parciais_ficam_abertos() {
        for (id, protocol, predicado, texto) in [
            ("claude-feliz", Protocolo::ClaudeStream, 0, None),
            ("codex-feliz", Protocolo::CodexAppServer, 1, Some("O")),
            ("antigravity-feliz", Protocolo::AgyStream, 2, Some("O")),
            ("cursor-feliz", Protocolo::CursorStream, 3, None),
        ] {
            let parcial = ate_frame(captura(id), move |out| match predicado {
                0 => {
                    out["type"] == "assistant"
                        && out.pointer("/message/content/0/type")
                            == Some(&Value::String("tool_use".into()))
                }
                1 => out["method"] == "item/agentMessage/delta",
                2 => {
                    out["event"] == "step_update"
                        && out.pointer("/step_update/step_index") == Some(&Value::from(3))
                        && out.pointer("/step_update/state")
                            == Some(&Value::String("ACTIVE".into()))
                }
                _ => out["type"] == "tool_call" && out["subtype"] == "started",
            });
            oraculo_estado(protocol, &parcial, "aberto", texto);
        }
    }

    /// Remover somente o frame final (e o que vem depois) deriva um processo ocioso sem sinal de conclusão.
    #[test]
    fn replay_derivado_processo_ocioso_sem_frame_final_nao_conclui_turno() {
        for (id, protocol, final_frame) in [
            ("claude-feliz", Protocolo::ClaudeStream, 0),
            ("codex-feliz", Protocolo::CodexAppServer, 1),
            ("antigravity-feliz", Protocolo::AgyStream, 2),
            ("cursor-feliz", Protocolo::CursorStream, 3),
        ] {
            let ocioso = sem_frame_final(captura(id), move |out| match final_frame {
                0 => out["type"] == "result",
                1 => out["method"] == "turn/completed",
                2 => out["event"] == "result",
                _ => out["type"] == "result",
            });
            oraculo_estado(protocol, &ocioso, "aberto", None);
            if id == "codex-feliz" {
                assert!(
                    ocioso.iter().any(|saida| quadro(saida)
                        .is_some_and(|out| out.pointer("/params/status/type")
                            == Some(&Value::String("idle".into())))),
                    "a captura Codex conserva o status idle, sem turn/completed"
                );
            }
        }
    }

    /// Os frames decisivos ficam no transcript. O snapshot só vê o que o motor produz.
    #[test]
    fn as_fixtures_gravadas_guardam_os_frames_que_a_captura_decidiu() {
        let ferramenta = gravada("claude-steer-ferramenta");
        let results: Vec<&Value> = outs(&ferramenta).into_iter().filter(|o| o["type"] == "result").collect();
        assert_eq!(results.len(), 1, "um único result");
        assert_eq!(results[0]["result"], "STEER_OK");
        assert!(ferramenta["transcript"].as_array().unwrap().iter().any(|e| e.get("in").and_then(|v| v.pointer("/message/content/0/text")).and_then(Value::as_str).is_some_and(|t| t.contains("MENSAGEM_STEER"))));

        let sem = gravada("claude-steer-sem-ferramenta");
        let results: Vec<&Value> = outs(&sem).into_iter().filter(|o| o["type"] == "result").collect();
        assert_eq!(results.len(), 2);
        assert!(!results[0]["result"].as_str().unwrap().contains("STEER_OK"));
        assert!(results[0]["result"].as_str().unwrap().contains("1\n2\n3"));
        assert_eq!(results[1]["result"], "STEER_OK");
        let steer_ms = sem["transcript"].as_array().unwrap().iter().find_map(|e| {
            e.get("in").and_then(|v| v.pointer("/message/content/0/text")).and_then(Value::as_str).filter(|t| t.contains("MENSAGEM_STEER")).map(|_| e["atMs"].as_u64().unwrap())
        }).unwrap();
        assert_eq!(steer_ms, 1974);

        let real = gravada("codex-interrompido-real");
        assert!(outs(&real).iter().any(|o| o["method"] == "turn/completed" && o.pointer("/params/turn/status").and_then(Value::as_str) == Some("interrupted")));
        assert!(real["transcript"].as_array().unwrap().iter().any(|e| e.get("in").and_then(|v| v.get("method")).and_then(Value::as_str) == Some("turn/interrupt")));

        let antes = gravada("codex-interrupt-antes-do-started");
        let ordem: Vec<&str> = antes["transcript"].as_array().unwrap().iter().filter_map(|e| {
            let body = e.get("out").or_else(|| e.get("in"))?;
            if body.get("error").and_then(|err| err.get("code")).and_then(Value::as_i64) == Some(-32600) {
                return Some("erro");
            }
            match body.get("method").and_then(Value::as_str) {
                Some("turn/started") => Some("started"),
                Some("turn/completed") => Some("completed"),
                Some("turn/interrupt") => Some("interrupt"),
                _ => None,
            }
        }).collect();
        assert!(ordem.windows(4).any(|w| w == ["interrupt", "erro", "started", "completed"]), "{ordem:?}");

        for id in ["cursor-queda", "antigravity-queda"] {
            let f = gravada(id);
            assert!(outs(&f).iter().all(|o| o.get("type") != Some(&Value::String("result".into())) && o.get("event") != Some(&Value::String("result".into()))), "{id}");
            assert!(f["transcript"].as_array().unwrap().iter().any(|e| e.get("close").is_some()), "{id}");
        }
    }
}
