//! O consumidor da fila de uma conversa (`thread_outbox`), sem relógio real, sem thread e sem barramento:
//! o teste avança um `i64` e roda `drain`. A conversa é uma porta falsa roteirizada.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::store::*;
use super::thread_outbox::*;
use crate::canal::timeline::Item;
use crate::conversa::envio::{SendError, SendMode};
use crate::database::DbConnection;

const T1: &str = "thread:t1";

/// A conversa de teste: o que ela responde a cada envio vem do roteiro; sem roteiro, aceita e passa a
/// trabalhar (um envio aceito abre um turno, como no agente de verdade).
struct Fake {
    target: Mutex<Target>,
    script: Mutex<VecDeque<Result<(), SendError>>>,
    sent: Mutex<Vec<(String, SendMode)>>,
    db: DbConnection,
    db_was_free_during_send: Mutex<Vec<bool>>,
    timeline: Mutex<Option<Vec<Item>>>,
    /// O `sending_at` da linha que está sendo enviada, lido DENTRO do envio (o banco precisa já ter o registro).
    sending_seen: Mutex<Vec<Option<i64>>>,
}

impl Fake {
    fn new(db: &DbConnection) -> Fake {
        Fake {
            target: Mutex::new(Target { open: true, alive: true, working: false }),
            script: Mutex::default(),
            sent: Mutex::default(),
            db: db.clone(),
            db_was_free_during_send: Mutex::default(),
            timeline: Mutex::new(Some(Vec::new())),
            sending_seen: Mutex::default(),
        }
    }
    fn working(&self, working: bool) {
        self.target.lock().unwrap().working = working;
    }
    fn then(&self, results: impl IntoIterator<Item = Result<(), SendError>>) {
        self.script.lock().unwrap().extend(results);
    }
    fn texts(&self) -> Vec<String> {
        self.sent.lock().unwrap().iter().map(|(t, _)| t.clone()).collect()
    }
}

impl ThreadPort for Fake {
    fn target(&self, _thread: &str) -> Target {
        *self.target.lock().unwrap()
    }
    fn send(&self, _thread: &str, text: &str, mode: SendMode) -> Result<(), SendError> {
        self.db_was_free_during_send.lock().unwrap().push(self.db.try_lock().is_ok());
        if let Ok(conn) = self.db.try_lock() {
            let at = conn.query_row("SELECT sending_at FROM peer_messages WHERE state = 'delivering' ORDER BY id LIMIT 1", [], |r| r.get(0)).ok().flatten();
            self.sending_seen.lock().unwrap().push(at);
        }
        let scripted = self.script.lock().unwrap().pop_front();
        let result = scripted.unwrap_or(Ok(()));
        if result.is_ok() {
            self.sent.lock().unwrap().push((text.to_string(), mode));
            self.target.lock().unwrap().working = true;
        }
        result
    }
    fn items(&self, _thread: &str) -> Option<Vec<Item>> {
        self.timeline.lock().unwrap().clone()
    }
}

fn db() -> DbConnection {
    Arc::new(Mutex::new(crate::database::test_db()))
}

fn compose(msg: &PeerMessage, _waited: Duration) -> String {
    format!("#{} {}", msg.id, msg.text)
}

fn tell(text: &str) -> NewMessage<'_> {
    NewMessage { kind: "tell", from_tab_id: "thread:lead", from_name: "Líder", to_tab_id: T1, to_name: "QA", text, ..Default::default() }
}

fn enqueue(db: &DbConnection, text: &str, now: i64) -> PeerMessage {
    let conn = db.lock().unwrap();
    match admit(&conn, &tell(text), State::Queued, now).unwrap() {
        Admission::New(m) => m,
        other => panic!("esperava nova, veio {other:?}"),
    }
}

fn get_msg(db: &DbConnection, id: i64) -> PeerMessage {
    get(&db.lock().unwrap(), id).unwrap().unwrap()
}

fn run(db: &DbConnection, port: &Fake, now: i64) -> Drained {
    drain(db, port, &compose, T1, now).unwrap()
}

#[test]
fn a_migracao_das_colunas_roda_duas_vezes_e_preserva_as_linhas_antigas() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // A tabela como era antes da etapa 2 (sem as quatro colunas), com uma linha dentro.
    conn.execute_batch(
        "CREATE TABLE peer_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, kind TEXT NOT NULL, from_tab_id TEXT NOT NULL,
            from_name TEXT NOT NULL, to_tab_id TEXT NOT NULL, to_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
            raw INTEGER NOT NULL DEFAULT 0, reply INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL CHECK(state IN ('queued','delivering','delivered','unconfirmed','cancelled','expired','refused')),
            position INTEGER NOT NULL DEFAULT 0, force_now INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER, edited_at INTEGER, note TEXT,
            depth INTEGER NOT NULL DEFAULT 0, parent_id INTEGER, answer_of INTEGER, reason TEXT, dedupe_key TEXT);
         INSERT INTO peer_messages (kind, from_tab_id, from_name, to_tab_id, text, state, created_at, updated_at)
            VALUES ('tell', 'a', 'A', 'b', 'oi', 'queued', 5, 5);",
    )
    .unwrap();
    migrate(&conn).unwrap();
    migrate(&conn).unwrap();
    let old = get(&conn, 1).unwrap().unwrap();
    assert_eq!((old.text.as_str(), old.state, old.created_at), ("oi", State::Queued, 5), "a linha antiga continua igual");
    assert_eq!((old.available_at, old.lease_until, old.delivery_mode, old.settled_at), (None, None, None, None));
    // O índice novo existe e há uma só coluna de cada.
    let columns: Vec<String> = conn.prepare("PRAGMA table_info(peer_messages)").unwrap().query_map([], |r| r.get(1)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(columns.iter().filter(|c| *c == "available_at").count(), 1);
    let index: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_peer_messages_ready'", [], |r| r.get(0)).unwrap();
    assert_eq!(index, 1);
}

#[test]
fn a_backoff_dobra_de_100_ms_ate_30_s() {
    assert_eq!([1, 2, 3, 4, 5].map(backoff_ms), [100, 200, 400, 800, 1_600]);
    assert_eq!(backoff_ms(20), 30_000, "teto de 30 s e sem estouro");
}

#[test]
fn a_fila_da_conversa_sai_em_ordem_uma_de_cada_vez() {
    let db = db();
    let port = Fake::new(&db);
    let ids: Vec<i64> = ["um", "dois", "tres"].iter().enumerate().map(|(i, t)| enqueue(&db, t, 1_000 + i as i64).id).collect();
    port.working(true);
    let busy = run(&db, &port, 2_000);
    assert!(matches!(busy.next, Next::Busy(_)));
    assert!(!busy.touched, "só olhou e dormiu: nada mudou no banco");
    assert!(port.texts().is_empty(), "com a conversa trabalhando, nada é enviado");
    port.working(false);
    // Um envio aceito abre um turno: a seguinte espera o turno acabar. Ordem fixa por `position, id`.
    for (round, id) in ids.iter().enumerate() {
        let done = run(&db, &port, 3_000 + round as i64);
        assert_eq!(done.delivered.iter().map(|m| m.id).collect::<Vec<_>>(), [*id]);
        assert_eq!(get_msg(&db, *id).state, State::Delivered);
        port.working(false);
    }
    assert_eq!(port.texts(), [format!("#{} um", ids[0]), format!("#{} dois", ids[1]), format!("#{} tres", ids[2])]);
    assert_eq!(run(&db, &port, 4_000).next, Next::Empty);
}

#[test]
fn o_envio_nao_segura_o_lock_do_banco() {
    let db = db();
    let port = Fake::new(&db);
    enqueue(&db, "oi", 1_000);
    run(&db, &port, 2_000);
    assert_eq!(*port.db_was_free_during_send.lock().unwrap(), [true]);
}

#[test]
fn o_enviar_agora_e_o_prazo_vencido_entram_no_turno_em_andamento() {
    let db = db();
    let port = Fake::new(&db);
    let forced = enqueue(&db, "urgente", 1_000);
    db.lock().unwrap().execute("UPDATE peer_messages SET force_now = 1 WHERE id = ?1", [forced.id]).unwrap();
    port.working(true);
    run(&db, &port, 2_000);
    assert_eq!(port.sent.lock().unwrap()[0].1, SendMode::SteerActive);
    assert_eq!(get_msg(&db, forced.id).delivery_mode.as_deref(), Some("steer_active"));

    let old = enqueue(&db, "velha", 10_000);
    port.working(true);
    assert_eq!(run(&db, &port, 10_000 + STEER_AFTER_MS - 1).next, Next::Busy(10_000 + STEER_AFTER_MS), "ainda dentro dos 15 min; volta quando vencer");
    run(&db, &port, 10_000 + STEER_AFTER_MS);
    assert_eq!(get_msg(&db, old.id).delivery_mode.as_deref(), Some("steer_active"), "passou de 15 min: entra mesmo assim");
}

#[test]
fn o_que_nao_foi_enviado_tenta_de_novo_com_backoff_e_so_a_quinta_falha_aparece() {
    let db = db();
    let port = Fake::new(&db);
    let msg = enqueue(&db, "tarefa", 1_000);
    port.then((0..5).map(|n| Err(SendError::NotSent(format!("sessão não abriu ({n})")))));
    let mut now = 2_000;
    for (attempt, wait) in [(1, 100), (2, 200), (3, 400), (4, 800)] {
        let r = run(&db, &port, now);
        assert!(r.failed.is_empty(), "falha invisível ao remetente até a última tentativa");
        let row = get_msg(&db, msg.id);
        assert_eq!((row.state, row.attempts, row.available_at), (State::Queued, attempt, Some(now + wait)));
        assert_eq!(r.next, Next::At(now + wait));
        // Antes da hora não envia; na hora, sim.
        assert_eq!(run(&db, &port, now + wait - 1).next, Next::At(now + wait));
        now += wait;
    }
    let last = run(&db, &port, now);
    let row = get_msg(&db, msg.id);
    assert_eq!((row.state, row.attempts, row.reason.as_deref()), (State::Expired, 5, Some(DELIVERY_FAILED)));
    assert!(row.note.as_deref().unwrap().contains("sessão não abriu (4)"));
    assert_eq!(last.failed.iter().map(|m| m.id).collect::<Vec<_>>(), [msg.id]);
    assert_eq!(run(&db, &port, now + 1).next, Next::Empty, "e não tenta uma sexta vez");
}

#[test]
fn o_erro_que_pode_ter_chegado_nao_se_repete() {
    let db = db();
    let port = Fake::new(&db);
    let msg = enqueue(&db, "tarefa", 1_000);
    port.then([Err(SendError::Unknown("o processo fechou depois de escrever".into()))]);
    let r = run(&db, &port, 2_000);
    let row = get_msg(&db, msg.id);
    assert_eq!((row.state, row.attempts), (State::Unconfirmed, 1));
    assert_eq!(r.failed.len(), 1);
    assert_eq!(run(&db, &port, 3_000).next, Next::Empty, "sem segunda tentativa: repetir duplicaria a ordem");
    assert_eq!(port.texts().len(), 0);
}

#[test]
fn a_conversa_ocupada_devolve_a_mensagem_sem_gastar_tentativa() {
    let db = db();
    let port = Fake::new(&db);
    let msg = enqueue(&db, "tarefa", 1_000);
    // A conversa parecia livre na checagem e abriu um turno antes do envio (a corrida).
    port.then([Err(SendError::Busy)]);
    let r = run(&db, &port, 2_000);
    let row = get_msg(&db, msg.id);
    assert_eq!((row.state, row.attempts, row.available_at), (State::Queued, 0, None));
    assert!(matches!(r.next, Next::Busy(_)));
    assert!(r.failed.is_empty());
}

#[test]
fn a_cabeca_com_backoff_segura_as_seguintes_para_manter_a_ordem() {
    let db = db();
    let port = Fake::new(&db);
    let first = enqueue(&db, "primeira", 1_000);
    enqueue(&db, "segunda", 1_001);
    port.then([Err(SendError::NotSent("x".into()))]);
    run(&db, &port, 2_000);
    assert_eq!(get_msg(&db, first.id).state, State::Queued);
    port.working(false);
    assert_eq!(run(&db, &port, 2_050).next, Next::At(2_100));
    assert!(port.texts().is_empty(), "a segunda não passa na frente da primeira");
}

#[test]
fn a_conversa_que_nao_existe_mais_expira_o_que_esperava_e_avisa() {
    let db = db();
    let port = Fake::new(&db);
    let a = enqueue(&db, "um", 1_000);
    let b = enqueue(&db, "dois", 1_001);
    port.target.lock().unwrap().open = false;
    let r = run(&db, &port, 2_000);
    assert_eq!(r.failed.iter().map(|m| m.id).collect::<Vec<_>>(), [a.id, b.id]);
    for id in [a.id, b.id] {
        let row = get_msg(&db, id);
        assert_eq!((row.state, row.reason.as_deref()), (State::Expired, Some(DELIVERY_FAILED)));
    }
    assert_eq!(r.next, Next::Empty);
}

#[test]
fn o_mesmo_id_do_chamador_nao_envia_duas_vezes() {
    let db = db();
    let port = Fake::new(&db);
    let new = NewMessage { client_id: Some("pedido-1"), ..tell("rode") };
    for _ in 0..2 {
        let conn = db.lock().unwrap();
        let _ = admit(&conn, &new, State::Queued, 1_000).unwrap();
    }
    run(&db, &port, 2_000);
    port.working(false);
    run(&db, &port, 3_000);
    assert_eq!(port.texts().len(), 1);
}

// ── Recuperação por marcador (reinício e posse vencida) ──────────────

fn user(text: &str) -> Item {
    Item { text: Some(text.to_string()), ..Item::new(crate::canal::timeline::ItemKind::User, "u1".into(), None) }
}

/// Uma mensagem que estava sendo enviada quando o consumidor sumiu.
fn sending(db: &DbConnection, text: &str, now: i64) -> PeerMessage {
    let msg = enqueue(db, text, now);
    claim_for_thread(&db.lock().unwrap(), msg.id, "queue_after_active", now, LEASE_MS).unwrap().unwrap()
}

#[test]
fn o_marcador_acha_a_mensagem_na_timeline() {
    let items = [user("[Mensagem #12 de Líder via ADE AGS] faça X"), user("[Mensagem #123 de Líder via ADE AGS] faça Y")];
    assert!(has_marker(&items, 12) && has_marker(&items, 123));
    assert!(!has_marker(&items, 1), "#1 não é prefixo de #12");
    assert!(!has_marker(&[user("falei da [Mensagem #12 de alguém]")], 12), "só vale no começo do texto");
}

#[test]
fn o_reinicio_com_o_marcador_na_timeline_marca_entregue_sem_enviar_de_novo() {
    let db = db();
    let port = Fake::new(&db);
    let msg = sending(&db, "tarefa", 1_000);
    *port.timeline.lock().unwrap() = Some(vec![user(&format!("[Mensagem #{} de Líder via ADE AGS] tarefa", msg.id))]);
    let r = recover(&db, &port, None, true, 5_000).unwrap();
    assert_eq!(r.delivered.len(), 1);
    assert_eq!(get_msg(&db, msg.id).state, State::Delivered);
    run(&db, &port, 6_000);
    assert!(port.texts().is_empty(), "o que chegou não é enviado outra vez");
}

#[test]
fn o_reinicio_sem_o_marcador_devolve_a_fila_e_envia_uma_vez() {
    let db = db();
    let port = Fake::new(&db);
    let msg = sending(&db, "tarefa", 1_000);
    let r = recover(&db, &port, None, true, 5_000).unwrap();
    assert_eq!(r.requeued.len(), 1);
    assert_eq!(get_msg(&db, msg.id).state, State::Queued);
    run(&db, &port, 6_000);
    port.working(false);
    run(&db, &port, 7_000);
    assert_eq!(port.texts().len(), 1, "enviada exatamente uma vez");
    assert_eq!(get_msg(&db, msg.id).state, State::Delivered);
}

#[test]
fn o_registro_de_enviando_esta_no_banco_antes_de_a_conversa_receber_a_mensagem() {
    let db = db();
    let port = Fake::new(&db);
    let msg = enqueue(&db, "tarefa", 1_000);
    run(&db, &port, 2_000);
    assert_eq!(*port.sending_seen.lock().unwrap(), [Some(2_000)], "durante o envio a linha já diz que o envio começou");
    assert_eq!(get_msg(&db, msg.id).state, State::Delivered);
}

#[test]
fn a_queda_antes_do_envio_comecar_e_provadamente_nao_enviada_e_volta_a_fila_em_qualquer_motor() {
    // Só é «provado» o que o banco diz: a posse foi tomada, mas o envio nem começou. Vale mesmo sem ler a timeline.
    let db = db();
    let port = Fake::new(&db);
    *port.timeline.lock().unwrap() = None;
    let msg = sending(&db, "tarefa", 1_000);
    assert_eq!(get_msg(&db, msg.id).sending_at, None);
    let r = recover(&db, &port, None, true, 5_000).unwrap();
    assert_eq!((r.requeued.len(), r.failed.len()), (1, 0));
    assert_eq!(get_msg(&db, msg.id).state, State::Queued);
}

#[test]
fn a_queda_depois_de_o_envio_comecar_sem_o_marcador_nunca_repete_a_ordem() {
    // O envio começou e o marcador não está na timeline: o motor pode ter escrito e caído antes de gravar o item.
    for timeline in [Some(Vec::new()), None] {
        let db = db();
        let port = Fake::new(&db);
        *port.timeline.lock().unwrap() = timeline;
        let msg = sending(&db, "tarefa", 1_000);
        mark_sending(&db.lock().unwrap(), msg.id, 1_500).unwrap();
        let r = recover(&db, &port, None, true, 5_000).unwrap();
        assert_eq!((r.requeued.len(), r.failed.len()), (0, 1));
        let row = get_msg(&db, msg.id);
        assert_eq!(row.state, State::Unconfirmed);
        assert!(row.note.as_deref().unwrap().contains("não dá para saber"));
    }
}

#[test]
fn o_marcador_na_timeline_vence_o_registro_de_enviando() {
    let db = db();
    let port = Fake::new(&db);
    let msg = sending(&db, "tarefa", 1_000);
    mark_sending(&db.lock().unwrap(), msg.id, 1_500).unwrap();
    *port.timeline.lock().unwrap() = Some(vec![user(&format!("[Mensagem #{} de Líder] tarefa", msg.id))]);
    assert_eq!(recover(&db, &port, None, true, 5_000).unwrap().delivered.len(), 1, "o cabeçalho mínimo (--raw interno) também é achado");
}

#[test]
fn a_posse_vigente_nao_e_tomada_e_a_vencida_sim() {
    let db = db();
    let port = Fake::new(&db);
    let msg = sending(&db, "tarefa", 1_000);
    let early = recover(&db, &port, Some(T1), false, 1_000 + LEASE_MS - 1).unwrap();
    assert!(early.requeued.is_empty() && early.failed.is_empty() && early.delivered.is_empty());
    assert_eq!(get_msg(&db, msg.id).state, State::Delivering, "o consumidor ainda a segura");
    let late = recover(&db, &port, Some(T1), false, 1_000 + LEASE_MS + 1).unwrap();
    assert_eq!(late.requeued.len(), 1);
}

#[test]
fn o_arranque_deixa_a_mensagem_de_conversa_para_a_recuperacao_e_o_terminal_segue_como_antes() {
    let conn = crate::database::test_db();
    let live: std::collections::HashSet<String> = ["thread:t1", "thread:lead", "tab-1", "tab-0"].map(String::from).into();
    let to_thread = NewMessage { kind: "tell", from_tab_id: "thread:lead", from_name: "L", to_tab_id: "thread:t1", to_name: "QA", text: "a", ..Default::default() };
    let to_tab = NewMessage { kind: "tell", from_tab_id: "tab-0", from_name: "L", to_tab_id: "tab-1", to_name: "QA", text: "a", ..Default::default() };
    let Admission::New(a) = admit(&conn, &to_thread, State::Delivering, 1_000).unwrap() else { panic!() };
    let Admission::New(b) = admit(&conn, &to_tab, State::Delivering, 1_000).unwrap() else { panic!() };
    let targets = resume(&conn, &live, 2_000).unwrap();
    assert_eq!(get(&conn, a.id).unwrap().unwrap().state, State::Delivering, "a conversa: quem decide é a recuperação");
    assert_eq!(get(&conn, b.id).unwrap().unwrap().state, State::Unconfirmed, "o terminal: como sempre");
    assert!(targets.contains(&"thread:t1".to_string()), "e o consumidor da conversa é religado");
}

// ── O app e a CLI escrevendo ao mesmo tempo (dois `Connection` no mesmo arquivo) ──

fn open_shared(path: &std::path::Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).unwrap();
    // Os mesmos pragmas do banco de produção (`database::connection`).
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;").unwrap();
    conn
}

#[test]
fn dois_processos_no_mesmo_banco_nao_perdem_nem_duplicam_mensagens() {
    let path = std::env::temp_dir().join(format!("ags-peer-queue-{}.db", uuid::Uuid::new_v4()));
    migrate(&open_shared(&path)).unwrap();
    const N: usize = 40;
    let (tx, rx) = std::sync::mpsc::channel::<i64>();
    let rx = Arc::new(Mutex::new(rx));
    // A "CLI": admite as mensagens (BEGIN IMMEDIATE) por uma conexão própria.
    let cli = {
        let path = path.clone();
        std::thread::spawn(move || {
            let conn = open_shared(&path);
            for i in 0..N {
                let text = format!("pedido {i}");
                let new = NewMessage { kind: "tell", from_tab_id: "thread:lead", from_name: "Líder", to_tab_id: T1, to_name: "QA", text: &text, ..Default::default() };
                let Admission::New(m) = admit(&conn, &new, State::Queued, 1_000 + i as i64).expect("admitir não pode falhar com 'database is locked'") else { panic!("esperava nova") };
                // Cada id vai duas vezes: os dois entregadores disputam a mesma mensagem.
                tx.send(m.id).unwrap();
                tx.send(m.id).unwrap();
            }
        })
    };
    // Dois entregadores, cada um com a sua conexão: a posse sai numa só escrita.
    let claimers: Vec<_> = (0..2)
        .map(|_| {
            let (path, rx) = (path.clone(), rx.clone());
            std::thread::spawn(move || {
                let conn = open_shared(&path);
                let mut won = Vec::new();
                loop {
                    let next = rx.lock().unwrap().recv();
                    let Ok(id) = next else { break };
                    if claim_for_thread(&conn, id, "queue_after_active", 2_000, LEASE_MS).expect("tomar não pode falhar com lock").is_some() {
                        won.push(id);
                    }
                }
                won
            })
        })
        .collect();
    cli.join().unwrap();
    let mut all: Vec<i64> = claimers.into_iter().flat_map(|c| c.join().unwrap()).collect();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), N, "cada mensagem foi tomada, e por um entregador só");
    let conn = open_shared(&path);
    let delivering: i64 = conn.query_row("SELECT COUNT(*) FROM peer_messages WHERE state = 'delivering' AND attempts = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(delivering, N as i64, "nenhuma ficou com duas tentativas");
    drop(conn);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}
