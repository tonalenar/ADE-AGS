use super::*;
use crate::canvas::{Board, Edge};

const UDID: &str = "AAA-1";

fn shared(kind: &str, name: &str, key: &str) -> SharedDevice {
    let ios = kind == "ios";
    SharedDevice { kind: kind.into(), name: name.into(), udid: ios.then(|| key.into()), serial: (!ios).then(|| key.into()) }
}

fn edge(id: &str, a: &str, b: &str) -> Edge {
    Edge { id: id.into(), a: a.into(), b: b.into() }
}

/// Canvas com um portal iOS ligado por corda ao `actor`, ou sem corda nenhuma.
fn boards(actor: &str, with_rope: bool) -> Boards {
    let mut b = Board::default();
    b.portals.insert("portal-ios".into(), Portal { name: "iPhone".into(), kind: Some("ios".into()), udid: Some(UDID.into()), ..Default::default() });
    if with_rope {
        b.edges.push(edge("e1", actor, "portal-ios"));
    }
    Boards::from([("main|/p".to_string(), b)])
}

fn panel(on: bool, control: bool) -> ChatShare {
    ChatShare { devices: if on { vec![shared("ios", "iPhone", UDID)] } else { vec![] }, control }
}

fn devices_of(list: Vec<Reach>) -> Vec<Reach> {
    list.into_iter().filter(|r| matches!(r.kind(), Some("android") | Some("ios"))).collect()
}

/// `{aba, thread} × {portal na corda, painel do chat, nenhum} × {controle ligado, desligado} × {shot, act}`.
/// A listagem e a autorização saem da mesma lista: o que se vê é o que se pode usar.
#[test]
fn matriz_de_alcance_ator_origem_controle_e_acao() {
    for actor in ["aba-1", "thread:abc"] {
        for origin in ["corda", "painel", "nenhum"] {
            for control in [true, false] {
                let list = devices_of(compute(&boards(actor, origin == "corda"), &panel(origin == "painel", control), actor));
                let node = match origin {
                    "corda" => "portal-ios".to_string(),
                    _ => format!("{CHAT_PREFIX}{UDID}"),
                };
                let case = format!("{actor}/{origin}/controle={control}");
                match origin {
                    "nenhum" => assert!(list.is_empty(), "{case}: não alcança nada"),
                    "corda" => {
                        // Portal do canvas: controle total, com ou sem a chave do painel.
                        assert_eq!(list.len(), 1, "{case}");
                        assert_eq!((list[0].source, list[0].control), (Source::Canvas, true), "{case}");
                        assert!(allows_in(&list, &node, UDID, "shot"), "{case}: shot");
                        assert!(allows_in(&list, &node, UDID, "act"), "{case}: act");
                    }
                    _ => {
                        assert_eq!(list.len(), 1, "{case}");
                        assert_eq!((list[0].source, list[0].control), (Source::ChatPanel, control), "{case}");
                        assert!(allows_in(&list, &node, UDID, "shot"), "{case}: o painel sempre deixa olhar");
                        assert!(allows_in(&list, &node, UDID, "tree"), "{case}: tree");
                        assert_eq!(allows_in(&list, &node, UDID, "act"), control, "{case}: act só com a chave");
                        assert_eq!(list[0].allows("tap").is_ok(), control, "{case}: tap só com a chave");
                    }
                }
                // Outro aparelho/nó nunca é autorizado por um id parecido.
                assert!(!allows_in(&list, "portal-outro", UDID, "shot"), "{case}");
                assert!(!allows_in(&list, &node, "OUTRO-UDID", "shot"), "{case}");
            }
        }
    }
}

#[test]
fn quem_nao_tem_corda_nao_alcanca_o_portal_de_outro() {
    let list = compute(&boards("aba-1", true), &panel(false, true), "aba-2");
    assert!(list.is_empty());
    // A conversa por protocolo é um ator como outro qualquer: a corda dela vale só para ela.
    let list = compute(&boards("thread:abc", true), &panel(false, true), "thread:abc");
    assert_eq!(list.len(), 1);
    assert!(compute(&boards("thread:abc", true), &panel(false, true), "thread:outra").is_empty());
}

#[test]
fn orquestrador_alcanca_os_portais_do_time_e_o_painel_so_olha_sem_a_chave() {
    let mut b = Board::default();
    b.portals.insert("portal-ios".into(), Portal { name: "iPhone".into(), kind: Some("ios".into()), udid: Some(UDID.into()), ..Default::default() });
    b.edges = vec![edge("e1", "lead", "worker"), edge("e2", "worker", "portal-ios")];
    b.orchestrators.push("lead".into());
    let boards = Boards::from([("k".to_string(), b)]);
    assert_eq!(compute(&boards, &ChatShare::default(), "lead").len(), 1);
    assert!(compute(&boards, &ChatShare::default(), "outro").is_empty());
}

#[test]
fn a_corda_cortada_entre_dois_passos_derruba_a_autorizacao() {
    // Passo 1: com corda. Passo 2: a pessoa tirou a corda. A mesma pergunta, refeita, agora diz não.
    let node = "portal-ios";
    let with = devices_of(compute(&boards("aba-1", true), &panel(false, false), "aba-1"));
    assert!(allows_in(&with, node, UDID, "act"));
    let without = devices_of(compute(&boards("aba-1", false), &panel(false, false), "aba-1"));
    assert!(!allows_in(&without, node, UDID, "act"));
    // Idem para a chave do painel desligada no meio da ação.
    let chat_node = format!("{CHAT_PREFIX}{UDID}");
    let on = devices_of(compute(&boards("aba-1", false), &panel(true, true), "aba-1"));
    let off = devices_of(compute(&boards("aba-1", false), &panel(true, false), "aba-1"));
    assert!(allows_in(&on, &chat_node, UDID, "act") && !allows_in(&off, &chat_node, UDID, "act"));
}

#[test]
fn o_painel_nao_entra_na_lista_de_portais_do_canvas() {
    // `portal list|act` usa só o canvas: aparelho do painel não é portal.
    let only_canvas = canvas_portals(&boards("aba-1", true), "aba-1");
    assert!(only_canvas.iter().all(|r| r.source == Source::Canvas && r.board.is_some()));
}

#[test]
fn o_que_ja_e_portal_do_canvas_nao_aparece_de_novo_pelo_painel() {
    let list = compute(&boards("aba-1", true), &panel(true, true), "aba-1");
    assert_eq!(list.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["portal-ios"]);
}

#[test]
fn sem_a_chave_da_pessoa_o_agente_so_ve() {
    let chat = |control| Reach { board: None, id: "chat:x".into(), portal: Portal::default(), source: Source::ChatPanel, control };
    assert!(chat(false).allows("shot").is_ok() && chat(false).allows("tree").is_ok());
    for action in ["tap", "swipe", "type", "key", "launch", "close", "start", "open", "button", "say", "act"] {
        let err = chat(false).allows(action).unwrap_err();
        assert!(err.contains("painel do chat") && err.contains("shot"), "{action}: {err}");
        assert!(chat(true).allows(action).is_ok(), "{action} com controle");
    }
}

#[test]
fn o_painel_so_compartilha_aparelho_com_identificador() {
    assert!(check_shared(&[shared("ios", "iPhone", "AAA")]).is_ok());
    assert!(check_shared(&[SharedDevice { kind: "ios".into(), name: "iPhone".into(), udid: None, serial: Some("x".into()) }]).is_err());
    assert!(check_shared(&[shared("android", "Pixel", " ")]).is_err());
    assert!(check_shared(&[shared("watch", "Relógio", "x")]).is_err());
    let parsed: Vec<SharedDevice> = serde_json::from_value(serde_json::json!([{ "kind": "android", "name": "Pixel", "serial": "emulator-5554" }])).unwrap();
    assert_eq!(parsed[0], shared("android", "Pixel", "emulator-5554"));
}
