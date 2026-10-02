use super::*;

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
