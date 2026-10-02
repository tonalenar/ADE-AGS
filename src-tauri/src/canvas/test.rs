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
