use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::timeline::{self, ItemKind, ToolStatus};
use super::timeline_cache::{Cache, Known};

fn temp_file(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ags-tl-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("t.jsonl")
}

fn append(path: &Path, linhas: &[serde_json::Value]) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for l in linhas {
        writeln!(f, "{l}").unwrap();
    }
}

fn user(n: usize) -> serde_json::Value {
    json!({"type": "user", "uuid": format!("u{n}"), "message": {"content": format!("pergunta {n}")}})
}

fn tool_use(id: &str) -> serde_json::Value {
    json!({"type": "assistant", "uuid": format!("a-{id}"), "message": {"content": [{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": "ls"}}]}})
}

fn tool_result(id: &str) -> serde_json::Value {
    json!({"type": "user", "uuid": format!("r-{id}"), "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": "ok"}]}})
}

fn known(d: &super::timeline_cache::TimelineDelta) -> Known {
    Known { rev: d.rev, count: d.total }
}

#[test]
fn a_primeira_leitura_traz_tudo_e_e_igual_a_leitura_inteira() {
    let path = temp_file("primeira");
    append(&path, &[user(1), tool_use("t1"), tool_result("t1")]);
    let mut c = Cache::new(&path, "claude-code");
    c.advance().unwrap();
    let d = c.delta(None);
    assert_eq!((d.from, d.total), (0, d.items.len()));
    assert_eq!(d.items, timeline::read(&path, "claude-code").unwrap().items);
}

#[test]
fn dois_pedidos_sem_mudanca_nao_mandam_a_timeline_de_novo() {
    let path = temp_file("sem-mudanca");
    append(&path, &[user(1), user(2)]);
    let mut c = Cache::new(&path, "claude-code");
    c.advance().unwrap();
    let primeira = c.delta(None);
    c.advance().unwrap();
    let segunda = c.delta(Some(known(&primeira)));
    assert!(segunda.items.is_empty());
    assert_eq!((segunda.from, segunda.total, segunda.rev), (2, 2, primeira.rev));
}

#[test]
fn so_o_que_cresceu_e_entregue_e_o_resultado_bate_com_a_leitura_inteira() {
    let path = temp_file("cresceu");
    append(&path, &[user(1), user(2)]);
    let mut c = Cache::new(&path, "claude-code");
    c.advance().unwrap();
    let primeira = c.delta(None);
    append(&path, &[user(3)]);
    c.advance().unwrap();
    let d = c.delta(Some(known(&primeira)));
    assert_eq!((d.from, d.items.len(), d.total), (2, 1, 3));
    let mut aplicado = primeira.items.clone();
    aplicado.truncate(d.from);
    aplicado.extend(d.items);
    assert_eq!(aplicado, timeline::read(&path, "claude-code").unwrap().items);
}

#[test]
fn resultado_de_ferramenta_que_chega_depois_reentrega_o_item_alterado() {
    let path = temp_file("ferramenta");
    append(&path, &[user(1), tool_use("t1"), user(2)]);
    let mut c = Cache::new(&path, "claude-code");
    c.advance().unwrap();
    let primeira = c.delta(None);
    assert_eq!(primeira.items[1].kind, ItemKind::Tool);
    assert_eq!(primeira.items[1].status, Some(ToolStatus::Running));
    append(&path, &[tool_result("t1"), user(3)]);
    c.advance().unwrap();
    let d = c.delta(Some(known(&primeira)));
    assert_eq!(d.from, 1, "recomeça no item da ferramenta");
    let mut aplicado = primeira.items[..d.from].to_vec();
    aplicado.extend(d.items);
    assert_eq!(aplicado, timeline::read(&path, "claude-code").unwrap().items);
    assert_eq!(aplicado[1].status, Some(ToolStatus::Done));
}

#[test]
fn linha_pela_metade_espera_o_resto_e_nao_se_perde() {
    let path = temp_file("metade");
    append(&path, &[user(1)]);
    let mut c = Cache::new(&path, "claude-code");
    c.advance().unwrap();
    let primeira = c.delta(None);
    let linha = format!("{}\n", user(2));
    let (a, b) = linha.split_at(linha.len() / 2);
    std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(a.as_bytes()).unwrap();
    c.advance().unwrap();
    assert!(c.delta(Some(known(&primeira))).items.is_empty());
    std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b.as_bytes()).unwrap();
    c.advance().unwrap();
    let d = c.delta(Some(known(&primeira)));
    assert_eq!((d.from, d.items.len()), (1, 1));
}

#[test]
fn revisao_desconhecida_ou_arquivo_que_encolheu_mandam_tudo() {
    let path = temp_file("encolheu");
    append(&path, &[user(1), user(2), user(3)]);
    let mut c = Cache::new(&path, "claude-code");
    c.advance().unwrap();
    let primeira = c.delta(None);
    assert_eq!(c.delta(Some(Known { rev: u64::MAX, count: 3 })).from, 0);
    std::fs::write(&path, format!("{}\n", user(9))).unwrap();
    c.advance().unwrap();
    let d = c.delta(Some(known(&primeira)));
    assert_eq!((d.from, d.total), (0, 1));
}
