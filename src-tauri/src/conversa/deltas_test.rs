use super::deltas::{payload, Coalescer, Entrada};

fn e(item: &str, kind: &str, text: &str) -> Entrada {
    Entrada { item_id: item.into(), kind: kind.into(), text: text.into() }
}

#[test]
fn varios_deltas_do_mesmo_item_viram_uma_emissao() {
    let mut c = Coalescer::default();
    assert!(c.push("t", "a", "assistant", "Ol"), "o primeiro abre a janela");
    for parte in ["á", ", ", "mundo"] {
        assert!(!c.push("t", "a", "assistant", parte), "os seguintes entram na mesma janela");
    }
    assert_eq!(c.take("t"), vec![e("a", "assistant", "Olá, mundo")]);
    assert!(c.take("t").is_empty(), "depois de tirar, a fila está vazia");
}

#[test]
fn a_ordem_entre_itens_e_tipos_diferentes_e_mantida() {
    let mut c = Coalescer::default();
    c.push("t", "a", "reasoning", "pen");
    c.push("t", "a", "reasoning", "sando");
    c.push("t", "b", "assistant", "x");
    c.push("t", "a", "reasoning", "y");
    assert_eq!(c.take("t"), vec![e("a", "reasoning", "pensando"), e("b", "assistant", "x"), e("a", "reasoning", "y")]);
}

#[test]
fn conversas_diferentes_nao_se_misturam_e_cada_uma_abre_a_sua_janela() {
    let mut c = Coalescer::default();
    assert!(c.push("t1", "a", "assistant", "1"));
    assert!(c.push("t2", "a", "assistant", "2"));
    assert_eq!(c.take("t1"), vec![e("a", "assistant", "1")]);
    assert_eq!(c.take("t2"), vec![e("a", "assistant", "2")]);
    assert!(c.push("t1", "a", "assistant", "3"), "tirada a fila, a próxima abre outra janela");
}

#[test]
fn o_payload_tem_o_formato_que_o_front_ja_le() {
    let p = payload("t", &e("a", "assistant", "oi"));
    assert_eq!(p, serde_json::json!({ "threadId": "t", "type": "delta", "itemId": "a", "delta": "oi", "kind": "assistant" }));
}
