use super::*;
use serde_json::json;

fn root() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("jev-tools-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn tool(name: &str) -> Value {
    json!({
        "version": 1, "name": name, "goal": "ler o título", "startUrl": "https://example.com/",
        "authority": "read", "inputs": [], "steps": [], "read": { "kind": "text", "maxLines": 60 },
        "createdAt": "2026-10-26T00:00:00Z"
    })
}

#[test]
fn nomes_validos_seguem_o_formato() {
    assert!(valid_name("titulo_da_home"));
    assert!(valid_name("a1"));
    assert!(!valid_name("Titulo"));
    assert!(!valid_name("1a"));
    assert!(!valid_name("com-hifen"));
    assert!(!valid_name("../fora"));
    assert!(!valid_name(""));
}

#[test]
fn salva_lista_carrega_e_apaga() {
    let r = root();
    save_in(&r, &tool("titulo"), false).unwrap();
    assert_eq!(load_in(&r, "titulo").unwrap()["goal"], "ler o título");
    let list = list_in(&r);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["name"], "titulo");
    assert_eq!(list[0]["read"], "text");
    delete_in(&r, "titulo").unwrap();
    assert!(list_in(&r).is_empty());
    assert!(load_in(&r, "titulo").unwrap_err().contains("ags portal tools"));
}

#[test]
fn nao_grava_por_cima_sem_replace() {
    let r = root();
    save_in(&r, &tool("titulo"), false).unwrap();
    assert!(save_in(&r, &tool("titulo"), false).unwrap_err().contains("--replace"));
    let mut newer = tool("titulo");
    newer["goal"] = json!("outro");
    save_in(&r, &newer, true).unwrap();
    assert_eq!(load_in(&r, "titulo").unwrap()["goal"], "outro");
}

#[test]
fn recusa_o_que_nao_e_ferramenta_de_leitura() {
    let r = root();
    let mut write = tool("escreve");
    write["authority"] = json!("write");
    assert!(save_in(&r, &write, false).unwrap_err().contains("leitura"));
    let mut no_url = tool("sem_url");
    no_url["startUrl"] = json!("file:///c:/x");
    assert!(save_in(&r, &no_url, false).is_err());
    let mut bad = tool("ok");
    bad["name"] = json!("../../fora");
    assert!(save_in(&r, &bad, false).is_err());
}
