use super::*;

#[test]
fn arquivo_ilegivel_nao_e_regravado() {
    let root = std::env::temp_dir().join(format!("ags-canvas-corrupt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("canvas.json");
    let original = br#"{"boards":"#;
    std::fs::write(&path, original).unwrap();
    TEST_FILE_PATH.with(|slot| *slot.borrow_mut() = Some(path.clone()));

    let result = save_board("w|a", Board::default());

    TEST_FILE_PATH.with(|slot| *slot.borrow_mut() = None);
    assert!(result.unwrap_err().contains("ilegível"));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn gemini_desktop_is_a_peer_and_its_crown_reaches_the_team_but_browsers_are_not_peers() {
    let mut b=Board::default();
    b.portals.insert("portal-g".into(),Portal{kind:Some("gemini".into()),..Default::default()});
    b.portals.insert("portal-web".into(),Portal::default());
    b.edges=vec![edge("a","portal-g","worker"),edge("b","worker","qa"),edge("c","worker","portal-web")];
    let mut all=Boards::from([("main|/p".into(),b)]);
    assert!(peers_of(&all,"worker").contains("portal-g"));
    assert!(!peers_of(&all,"worker").contains("portal-web"));
    assert!(!reachable(&all,"portal-g").contains("qa"));
    all.get_mut("main|/p").unwrap().orchestrators.push("portal-g".into());
    assert!(reachable(&all,"portal-g").contains("qa"));
}

fn connected(b: &Boards, from: &str, to: &str) -> bool {
    peers_of(b, from).contains(to)
}

fn edge(id: &str, a: &str, b: &str) -> Edge {
    Edge { id: id.into(), a: a.into(), b: b.into() }
}

fn boards(edges: &[(&str, Vec<Edge>)]) -> Boards {
    edges
        .iter()
        .map(|(key, e)| (key.to_string(), Board { edges: e.clone(), ..Default::default() }))
        .collect()
}

#[test]
fn una_conexion_vale_para_los_dos_lados() {
    let b = boards(&[("proj", vec![edge("1", "a", "b")])]);
    assert!(connected(&b, "a", "b"));
    assert!(connected(&b, "b", "a"));
}

#[test]
fn sin_conexion_no_hay_permiso() {
    let b = boards(&[("proj", vec![edge("1", "a", "b")])]);
    assert!(!connected(&b, "a", "c"));
    assert!(!connected(&b, "c", "a"));
}

/// Estar conectado con alguien que está conectado con otro no da acceso al otro: el
/// permiso es por conexión directa.
#[test]
fn el_permiso_no_es_transitivo() {
    let b = boards(&[("proj", vec![edge("1", "a", "b"), edge("2", "b", "c")])]);
    assert!(!connected(&b, "a", "c"));
}

#[test]
fn los_vecinos_salen_de_todos_los_canvas_sin_repetir() {
    let b = boards(&[
        ("uno", vec![edge("1", "a", "b"), edge("2", "a", "c")]),
        ("dos", vec![edge("3", "b", "a")]),
    ]);
    let peers: Vec<String> = peers_of(&b, "a").into_iter().collect();
    assert_eq!(peers, vec!["b".to_string(), "c".to_string()]);
}

/// Una conexión de una tab consigo misma no la vuelve su propio vecino.
#[test]
fn una_tab_no_es_vecina_de_si_misma() {
    let b = boards(&[("proj", vec![edge("1", "a", "a")])]);
    assert!(peers_of(&b, "a").is_empty());
}

fn with_orchestrator(mut b: Boards, key: &str, tab: &str) -> Boards {
    b.get_mut(key).unwrap().orchestrators.push(tab.into());
    b
}

#[test]
fn el_equipo_sigue_las_conexiones_en_varios_pasos() {
    let b = boards(&[("proj", vec![edge("1", "lider", "a"), edge("2", "a", "b"), edge("3", "x", "y")])]);
    let team: Vec<String> = team_of(&b, "lider").into_iter().collect();
    assert_eq!(team, vec!["a".to_string(), "b".to_string()]);
}

#[test]
fn una_orquestadora_alcanza_a_todo_su_equipo() {
    let b = boards(&[("proj", vec![edge("1", "lider", "a"), edge("2", "a", "b")])]);
    let b = with_orchestrator(b, "proj", "lider");
    assert!(reachable(&b, "lider").contains("b"));
}

#[test]
fn una_chave_de_sessao_nao_cria_escopo_de_time() {
    let mut board = Board::default();
    board.nodes = serde_json::json!({ "lead": {}, "worker": {} });
    board.edges.push(edge("e1", "lead", "worker"));
    board.orchestrators.push("lead".into());
    let all = Boards::from([("main|/repo#s:thread:abc".into(), board)]);

    assert!(mission_of_tab(&all, "lead").is_none());
    assert!(conversation_of_tab(&all, "lead").is_none());
    assert!(team_scope_of_tab(&all, "lead").is_none());
    // As cordas continuam sendo a autorização geral de peers.
    assert!(reachable(&all, "lead").contains("worker"));
}

/// Estar en el equipo de una orquestadora no da su alcance: `a` sigue hablando solo con
/// quien está conectada directamente.
#[test]
fn el_resto_del_equipo_sigue_con_alcance_directo() {
    let b = boards(&[("proj", vec![edge("1", "lider", "a"), edge("2", "a", "b"), edge("3", "b", "c")])]);
    let b = with_orchestrator(b, "proj", "lider");
    assert!(!reachable(&b, "a").contains("c"));
    assert!(reachable(&b, "a").contains("lider"));
}

#[test]
fn sin_marca_no_hay_orquestadora() {
    let b = boards(&[("proj", vec![edge("1", "lider", "a")])]);
    assert!(!is_orchestrator(&b, "lider"));
}

fn with_notes(edges: Vec<Edge>, notes: &[&str], orchestrators: &[&str]) -> Boards {
    let board = Board {
        edges,
        notes: notes.iter().map(|id| (id.to_string(), Note { name: id.to_string(), ..Default::default() })).collect(),
        orchestrators: orchestrators.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    };
    Boards::from([("main|/p".to_string(), board)])
}

#[test]
fn una_nota_no_es_un_agente_ni_un_puente_entre_agentes() {
    let b = with_notes(vec![edge("1", "a", "note-x"), edge("2", "b", "note-x")], &["note-x"], &["a"]);
    assert!(peers_of(&b, "a").is_empty());
    assert!(team_of(&b, "a").is_empty(), "una nota compartida no junta equipos");
}

#[test]
fn las_notas_alcanzables_son_las_conectadas() {
    let b = with_notes(vec![edge("1", "a", "note-x"), edge("2", "b", "note-y")], &["note-x", "note-y"], &[]);
    let ids = |tab: &str| notes_for(&b, tab).into_iter().map(|(_, id)| id).collect::<Vec<_>>();
    assert_eq!(ids("a"), vec!["note-x"]);
    assert_eq!(ids("b"), vec!["note-y"]);
    assert!(ids("c").is_empty());
}

#[test]
fn una_orquestadora_alcanza_las_notas_de_su_equipo() {
    let b = with_notes(
        vec![edge("1", "lead", "w1"), edge("2", "w1", "note-x"), edge("3", "w2", "note-y")],
        &["note-x", "note-y"],
        &["lead"],
    );
    let ids: Vec<_> = notes_for(&b, "lead").into_iter().map(|(_, id)| id).collect();
    assert_eq!(ids, vec!["note-x"]);
}

#[test]
fn una_conexion_a_una_nota_borrada_no_da_acceso() {
    let b = with_notes(vec![edge("1", "a", "note-x")], &[], &[]);
    assert!(notes_for(&b, "a").is_empty());
}

#[test]
fn las_notas_sobreviven_al_ida_y_vuelta_por_el_archivo() {
    let raw = r#"{"nodes":{},"edges":[],"viewport":{},"orchestrators":[],
        "notes":{"note-1":{"name":"Plano","content":"- a","box":{"x":1,"y":2,"w":3,"h":4}}}}"#;
    let board: Board = serde_json::from_str(raw).unwrap();
    let back = serde_json::to_value(&board).unwrap();
    assert_eq!(back["notes"]["note-1"]["box"]["w"], 3);
    assert_eq!(back["notes"]["note-1"]["content"], "- a");
}

#[test]
fn un_portal_no_es_un_agente_pero_si_se_alcanza() {
    let mut b = with_notes(vec![edge("1", "a", "portal-x"), edge("2", "b", "portal-x")], &[], &["a"]);
    b.get_mut("main|/p").unwrap().portals.insert("portal-x".into(), Portal { name: "Web".into(), ..Default::default() });
    assert!(peers_of(&b, "a").is_empty());
    assert!(team_of(&b, "a").is_empty(), "un portal compartido no junta equipos");
    assert_eq!(portals_for(&b, "a"), vec![("main|/p".to_string(), "portal-x".to_string())]);
    assert!(portals_for(&b, "c").is_empty());
}

#[test]
fn los_portales_sobreviven_al_ida_y_vuelta_por_el_archivo() {
    let raw = r#"{"edges":[],"portals":{"portal-1":{"name":"Web","url":"http://localhost:5173","box":{"x":1,"y":2,"w":3,"h":4}}}}"#;
    let board: Board = serde_json::from_str(raw).unwrap();
    let back = serde_json::to_value(&board).unwrap();
    assert_eq!(back["portals"]["portal-1"]["url"], "http://localhost:5173");
    assert_eq!(back["portals"]["portal-1"]["box"]["h"], 4);
}

#[test]
fn guardar_el_canvas_conserva_las_pilas_de_notas() {
    // Si `Note` no llevara `stack`/`front`, pasar por este struct deshacería las pilas.
    let raw = r#"{"nodes":{},"edges":[],"notes":{
        "note-a":{"name":"A","content":"x","box":{"x":1,"y":2,"w":3,"h":4},"stack":"note-a","front":false},
        "note-b":{"name":"B","content":"y","box":{"x":1,"y":2,"w":3,"h":4},"stack":"note-a","front":true},
        "note-c":{"name":"C","content":"z","box":{"x":9,"y":9,"w":3,"h":4}}}}"#;
    let board: Board = serde_json::from_str(raw).unwrap();
    assert_eq!(board.notes["note-b"].stack.as_deref(), Some("note-a"));
    assert_eq!(board.notes["note-b"].front, Some(true));
    let back = serde_json::to_value(&board).unwrap();
    assert_eq!(back["notes"]["note-a"]["stack"], "note-a");
    assert_eq!(back["notes"]["note-a"]["front"], false);
    assert_eq!(back["notes"]["note-b"]["front"], true);
    // Una suelta no gana campos nuevos.
    assert!(back["notes"]["note-c"].get("stack").is_none() && back["notes"]["note-c"].get("front").is_none());
}

#[test]
fn la_mision_de_una_tab_sale_de_la_clave_del_canvas_de_misiones() {
    let mut mission_board = Board::default();
    mission_board.orchestrators = vec!["lead".into()];
    mission_board.nodes = serde_json::json!({ "lead": {}, "worker": {} });
    let folder_board = Board { nodes: serde_json::json!({ "solo": {} }), ..Default::default() };
    let boards = Boards::from([
        ("main|C:/p#m:m-42".to_string(), mission_board),
        ("main|C:/p".to_string(), folder_board),
    ]);
    assert_eq!(mission_of_tab(&boards, "lead").as_deref(), Some("m-42"));
    assert_eq!(mission_of_tab(&boards, "worker").as_deref(), Some("m-42"));
    assert_eq!(mission_of_tab(&boards, "solo"), None, "el canvas de la carpeta no es una misión");
    assert_eq!(mission_of_tab(&boards, "ghost"), None);
}

#[test]
fn os_nos_de_conversa_por_protocolo_sobrevivem_ao_salvar_e_canvas_antigo_abre_sem_eles() {
    // O front escreve `threads`; passar pelo struct (carregar e salvar) não pode perdê-lo.
    let json = serde_json::json!({
        "main|/p": {
            "nodes": {},
            "edges": [{ "id": "e1", "a": "t1", "b": "thread:abc" }],
            "threads": { "thread:abc": { "x": 10, "y": 20, "w": 460, "h": 540 } }
        }
    });
    let boards: Boards = serde_json::from_value(json).unwrap();
    let back = serde_json::to_value(&boards).unwrap();
    assert_eq!(back["main|/p"]["threads"]["thread:abc"]["w"], 460);
    assert_eq!(back["main|/p"]["edges"][0]["b"], "thread:abc");

    // Um canvas de antes do campo: abre, e `threads` vem vazio (não some nem quebra).
    let old: Boards = serde_json::from_value(serde_json::json!({ "main|/q": { "nodes": {} } })).unwrap();
    assert!(old["main|/q"].threads.is_null());
}

#[test]
fn os_nos_de_agente_remoto_sobrevivem_ao_salvar_e_autorizam_cordas_e_coroa() {
    let json = serde_json::json!({
        "main|/p": {
            "nodes": { "t1": { "x": 0, "y": 0, "w": 600, "h": 400 } },
            "remotes": { "remote:cli-1": { "x": 640, "y": 0, "w": 320, "h": 176 } },
            "edges": [{ "id": "e1", "a": "remote:cli-1", "b": "t1" }],
            "orchestrators": ["remote:cli-1"]
        }
    });
    let boards: Boards = serde_json::from_value(json).unwrap();
    let back = serde_json::to_value(&boards).unwrap();
    assert_eq!(back["main|/p"]["remotes"]["remote:cli-1"]["w"], 320);
    assert!(peers_of(&boards, "remote:cli-1").contains("t1"));
    assert!(is_orchestrator_here(&boards, "remote:cli-1"));

    // Um canvas de antes do campo `remotes`: abre normalmente.
    let old: Boards = serde_json::from_value(serde_json::json!({ "main|/q": { "nodes": {} } })).unwrap();
    assert!(old["main|/q"].remotes.is_null());
}

#[test]
fn papeis_ilegivel_nao_e_regravado() {
    let dir = std::env::temp_dir().join(format!("ags-roles-bad-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("canvas-roles.json");
    std::fs::write(&path, "{").unwrap();
    let original = std::fs::read(&path).unwrap();
    let err = super::roles::read_custom_at(&path).unwrap_err();
    assert!(err.contains("ilegível"), "{err}");
    assert_eq!(std::fs::read(&path).unwrap(), original);
    let _ = std::fs::remove_dir_all(&dir);
}

mod persistence_tests {
    use super::*;
    use crate::canvas::persistence::{
        ensure_worker, CanvasIo, CanvasStore, DiskCanvasIo, FSYNC_INTERVAL, SAVE_DEBOUNCE,
    };
    use crate::util::user_json::SyncMode;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    struct TempCanvas {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempCanvas {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ags-canvas-perf-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("canvas.json");
            Self { dir, path }
        }
    }

    impl Drop for TempCanvas {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[derive(Default)]
    struct IoCounters {
        reads: AtomicUsize,
        writes: AtomicUsize,
        fsyncs: AtomicUsize,
        write_modes: Mutex<Vec<SyncMode>>,
        on_write: Mutex<Option<mpsc::Sender<SyncMode>>>,
    }

    struct CountingDiskIo {
        inner: DiskCanvasIo,
        counters: Arc<IoCounters>,
    }

    impl CountingDiskIo {
        fn new() -> (Self, Arc<IoCounters>) {
            let counters = Arc::new(IoCounters::default());
            (
                Self {
                    inner: DiskCanvasIo,
                    counters: Arc::clone(&counters),
                },
                counters,
            )
        }
    }

    impl CanvasIo for CountingDiskIo {
        fn read(&self, path: &Path) -> Result<Boards, String> {
            self.counters.reads.fetch_add(1, Ordering::SeqCst);
            self.inner.read(path)
        }

        fn write(&self, path: &Path, boards: &Boards, sync: SyncMode) -> Result<(), String> {
            self.inner.write(path, boards, sync)?;
            self.counters.writes.fetch_add(1, Ordering::SeqCst);
            if sync == SyncMode::Sync {
                self.counters.fsyncs.fetch_add(1, Ordering::SeqCst);
            }
            self.counters.write_modes.lock().unwrap().push(sync);
            if let Some(tx) = self.counters.on_write.lock().unwrap().as_ref() {
                let _ = tx.send(sync);
            }
            Ok(())
        }

        fn sync(&self, path: &Path) -> Result<(), String> {
            self.inner.sync(path)?;
            self.counters.fsyncs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn board_with_note(content: &str) -> Board {
        let mut board = Board::default();
        board.notes.insert(
            "note-1".into(),
            Note {
                name: "N".into(),
                content: content.into(),
                ..Default::default()
            },
        );
        board
    }

    /// N saves dentro da janela de 300 ms devem coalescer em 1 única escrita em disco
    /// contendo a última versão, sem `fsync` quente.
    #[test]
    fn n_saves_em_300ms_coalescem_em_uma_unica_escrita_com_a_ultima_versao() {
        let tmp = TempCanvas::new("coalesce");
        let (io, counters) = CountingDiskIo::new();
        let store = CanvasStore::new(io, SAVE_DEBOUNCE, FSYNC_INTERVAL);
        let t0 = Instant::now();

        for i in 0..20 {
            let at = t0 + Duration::from_millis(i * 10);
            store
                .save_at(&tmp.path, "main|/proj", board_with_note(&format!("v{i}")), at)
                .unwrap();
        }

        // Antes do debounce vencer (último save em t0 + 190ms -> deadline em t0 + 490ms): 0 escritas.
        assert_eq!(
            store.flush_due_at(t0 + Duration::from_millis(400)).unwrap(),
            0
        );
        assert_eq!(counters.writes.load(Ordering::SeqCst), 0);

        // Após o debounce vencer: 1 única escrita atômica, sem fsync, com a versão final v19.
        assert_eq!(
            store.flush_due_at(t0 + Duration::from_millis(490)).unwrap(),
            1
        );
        assert_eq!(counters.writes.load(Ordering::SeqCst), 1);
        assert_eq!(counters.fsyncs.load(Ordering::SeqCst), 0);
        assert_eq!(
            *counters.write_modes.lock().unwrap(),
            vec![SyncMode::AtomicNoSync]
        );

        let from_disk = DiskCanvasIo.read(&tmp.path).unwrap();
        assert_eq!(from_disk["main|/proj"].notes["note-1"].content, "v19");
    }

    /// Após a primeira carga, leituras repetidas usam o cache em memória sem reler/parsear
    /// `canvas.json`, e enxergam imediatamente o que foi salvo mesmo antes do debounce gravar.
    #[test]
    fn leitura_usa_cache_sem_reler_disco_e_enxerga_save_imediatamente() {
        let tmp = TempCanvas::new("cache");
        let initial = Boards::from([("main|/p".into(), board_with_note("inicial"))]);
        DiskCanvasIo
            .write(&tmp.path, &initial, SyncMode::AtomicNoSync)
            .unwrap();

        let (io, counters) = CountingDiskIo::new();
        let store = CanvasStore::new(io, SAVE_DEBOUNCE, FSYNC_INTERVAL);
        let t0 = Instant::now();

        let first = store.load_at(&tmp.path, t0).unwrap();
        assert_eq!(first["main|/p"].notes["note-1"].content, "inicial");
        assert_eq!(counters.reads.load(Ordering::SeqCst), 1);

        for _ in 0..10 {
            let cached = store.load_at(&tmp.path, t0).unwrap();
            assert_eq!(cached["main|/p"].notes["note-1"].content, "inicial");
        }
        assert_eq!(
            counters.reads.load(Ordering::SeqCst),
            1,
            "leituras seguintes não podem reler nem parsear o arquivo"
        );

        // Um save atualiza o cache na hora sem reler o disco e sem bloquear esperando o debounce.
        store
            .save_at(&tmp.path, "main|/p", board_with_note("atualizado"), t0)
            .unwrap();
        let updated = store.load_at(&tmp.path, t0).unwrap();
        assert_eq!(updated["main|/p"].notes["note-1"].content, "atualizado");
        assert_eq!(counters.reads.load(Ordering::SeqCst), 1);
        assert_eq!(counters.writes.load(Ordering::SeqCst), 0);
    }

    /// `fsync` não roda em toda escrita: só quando o intervalo maior (`FSYNC_INTERVAL`) vence.
    #[test]
    fn fsync_so_roda_apos_intervalo_maior() {
        let tmp = TempCanvas::new("fsync-interval");
        let (io, counters) = CountingDiskIo::new();
        let store = CanvasStore::new(io, SAVE_DEBOUNCE, FSYNC_INTERVAL);
        let t0 = Instant::now();

        store
            .save_at(&tmp.path, "main|/p", board_with_note("v1"), t0)
            .unwrap();
        store.flush_due_at(t0 + SAVE_DEBOUNCE).unwrap();
        assert_eq!(counters.writes.load(Ordering::SeqCst), 1);
        assert_eq!(counters.fsyncs.load(Ordering::SeqCst), 0);

        // 5 s depois: nova gravação ainda sem fsync.
        let t1 = t0 + Duration::from_secs(5);
        store
            .save_at(&tmp.path, "main|/p", board_with_note("v2"), t1)
            .unwrap();
        store.flush_due_at(t1 + SAVE_DEBOUNCE).unwrap();
        assert_eq!(counters.writes.load(Ordering::SeqCst), 2);
        assert_eq!(counters.fsyncs.load(Ordering::SeqCst), 0);

        // Sem nova escrita, ao passar FSYNC_INTERVAL: faz apenas sync_all sem reescrever o JSON.
        store
            .flush_due_at(t0 + FSYNC_INTERVAL + Duration::from_secs(1))
            .unwrap();
        assert_eq!(counters.writes.load(Ordering::SeqCst), 2);
        assert_eq!(counters.fsyncs.load(Ordering::SeqCst), 1);
    }

    /// No fechamento da app, o flush grava imediatamente a última versão pendente com `fsync`.
    /// Se a última versão já estava gravada sem `fsync`, apenas sincroniza o arquivo.
    #[test]
    fn flush_no_exit_grava_o_ultimo_estado_com_fsync() {
        let tmp = TempCanvas::new("exit-flush");
        let (io, counters) = CountingDiskIo::new();
        let store = CanvasStore::new(io, SAVE_DEBOUNCE, FSYNC_INTERVAL);
        let t0 = Instant::now();

        store
            .save_at(&tmp.path, "main|/p", board_with_note("v1"), t0)
            .unwrap();
        store
            .save_at(&tmp.path, "main|/p", board_with_note("v2"), t0)
            .unwrap();
        assert_eq!(counters.writes.load(Ordering::SeqCst), 0);

        // Fecha antes do debounce vencer: grava v2 atomicamente com fsync.
        store
            .flush_all_with_fsync(t0 + Duration::from_millis(50))
            .unwrap();
        assert_eq!(counters.writes.load(Ordering::SeqCst), 1);
        assert_eq!(counters.fsyncs.load(Ordering::SeqCst), 1);
        assert_eq!(
            DiskCanvasIo.read(&tmp.path).unwrap()["main|/p"].notes["note-1"].content,
            "v2"
        );

        // Novo save já escrito pelo debounce sem fsync; no exit só chama sync sem reescrever.
        let t1 = t0 + Duration::from_secs(1);
        store
            .save_at(&tmp.path, "main|/p", board_with_note("v3"), t1)
            .unwrap();
        store.flush_due_at(t1 + SAVE_DEBOUNCE).unwrap();
        assert_eq!(counters.writes.load(Ordering::SeqCst), 2);
        assert_eq!(counters.fsyncs.load(Ordering::SeqCst), 1);

        store.flush_all_with_fsync(t1 + Duration::from_secs(2)).unwrap();
        assert_eq!(counters.writes.load(Ordering::SeqCst), 2);
        assert_eq!(counters.fsyncs.load(Ordering::SeqCst), 2);
        assert_eq!(
            DiskCanvasIo.read(&tmp.path).unwrap()["main|/p"].notes["note-1"].content,
            "v3"
        );
    }

    /// Prova o worker em segundo plano real (`Condvar`): coalesce rajada e notifica pelo canal.
    #[test]
    fn worker_em_segundo_plano_coalesce_e_persiste_em_disco() {
        let tmp = TempCanvas::new("worker");
        let (io, counters) = CountingDiskIo::new();
        let (tx, rx) = mpsc::channel();
        *counters.on_write.lock().unwrap() = Some(tx);

        let store = Arc::new(CanvasStore::new(
            io,
            Duration::from_millis(5),
            Duration::from_secs(60),
        ));
        let now = Instant::now();
        for i in 0..5 {
            store
                .save_at(&tmp.path, "main|/p", board_with_note(&format!("w{i}")), now)
                .unwrap();
        }
        ensure_worker(&store);

        let mode = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker deveria gravar após o debounce");
        store.stop_worker();

        assert_eq!(mode, SyncMode::AtomicNoSync);
        assert_eq!(counters.writes.load(Ordering::SeqCst), 1);
        assert_eq!(
            DiskCanvasIo.read(&tmp.path).unwrap()["main|/p"].notes["note-1"].content,
            "w4"
        );
    }

    /// Caminho público global: `save_board` + `flush_pending_saves` persiste o último estado.
    #[test]
    fn flush_pending_saves_global_grava_ultimo_estado() {
        let tmp = TempCanvas::new("global-flush");
        TEST_FILE_PATH.with(|slot| *slot.borrow_mut() = Some(tmp.path.clone()));

        save_board("main|/g", board_with_note("antes")).unwrap();
        save_board("main|/g", board_with_note("final")).unwrap();
        // Leitura imediata pelo cache já devolve o valor final.
        assert_eq!(
            load_boards().unwrap()["main|/g"].notes["note-1"].content,
            "final"
        );
        flush_pending_saves().unwrap();

        TEST_FILE_PATH.with(|slot| *slot.borrow_mut() = None);

        let on_disk = DiskCanvasIo.read(&tmp.path).unwrap();
        assert_eq!(on_disk["main|/g"].notes["note-1"].content, "final");
    }

    /// Os comandos Tauri `canvas_load` e `canvas_save` não podem rodar síncronos na thread principal.
    #[test]
    fn comandos_canvas_sao_assincronos_com_spawn_blocking() {
        let src = include_str!("mod.rs");
        let section = &src[src.find("// ── Comandos Tauri").expect("seção de comandos")..];
        assert!(
            section.contains("pub async fn canvas_load("),
            "canvas_load precisa ser async para sair da thread principal"
        );
        assert!(
            section.contains("pub async fn canvas_save("),
            "canvas_save precisa ser async para sair da thread principal"
        );
        assert!(
            section.matches("spawn_blocking(").count() >= 2,
            "canvas_load e canvas_save devem delegar I/O para spawn_blocking"
        );
    }
}
