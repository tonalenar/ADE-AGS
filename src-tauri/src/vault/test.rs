use super::*;

fn setup_isolated_vault() -> String {
    let service = format!("ade-ags.vault.test.{}", uuid::Uuid::new_v4());
    set_test_service(service.clone());
    service
}

#[test]
fn adicionar_e_listar_nao_devolve_senha() {
    setup_isolated_vault();
    let senha = "SenhaSuperSecreta!#2026";
    let added = add("https://app.exemplo.com/login", "ton@exemplo.com", "Exemplo", senha)
        .expect("deve adicionar login válido");

    assert_eq!(added.origin, "https://app.exemplo.com");
    assert_eq!(added.username, "ton@exemplo.com");
    assert_eq!(added.label, "Exemplo");
    assert!(added.allowed_agents.is_empty());
    assert!(added.last_used_at.is_none());

    let entries = list().expect("deve listar entradas");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, added.id);

    let serialized = serde_json::to_string(&entries).expect("serializa lista");
    assert!(
        !serialized.contains(senha),
        "o JSON de list() nunca pode conter a senha"
    );

    let secret = password_for_fill(&added.id).expect("deve recuperar senha internamente");
    assert_eq!(secret.as_str(), senha);
    assert!(!format!("{secret:?}").contains(senha));
}

#[test]
fn origem_normalizada() {
    setup_isolated_vault();
    let entry = add(
        "https://Conta.Exemplo.com/login?x=1#topo",
        "usuario",
        "Conta",
        "segredo-123",
    )
    .expect("origem https válida");
    assert_eq!(entry.origin, "https://conta.exemplo.com");

    let with_default_port = add(
        "https://Conta.Exemplo.com:443/outro",
        "usuario2",
        "Conta 2",
        "segredo-456",
    )
    .expect("porta padrão 443 deve ser removida");
    assert_eq!(with_default_port.origin, "https://conta.exemplo.com");

    let with_custom_port = add(
        "https://Conta.Exemplo.com:8443/painel",
        "usuario3",
        "Conta 3",
        "segredo-789",
    )
    .expect("porta não padrão deve ser preservada");
    assert_eq!(with_custom_port.origin, "https://conta.exemplo.com:8443");

    let local = add(
        "http://LOCALHOST:3000/auth",
        "dev",
        "Local",
        "segredo-local",
    )
    .expect("http localhost permitido");
    assert_eq!(local.origin, "http://localhost:3000");

    let loopback = add("http://127.0.0.1:8080/login", "dev", "Loopback", "segredo-lb")
        .expect("http 127.0.0.1 permitido");
    assert_eq!(loopback.origin, "http://127.0.0.1:8080");
}

#[test]
fn origem_http_publica_recusada() {
    setup_isolated_vault();
    assert!(add("http://exemplo.com/login", "u", "Publico", "senha").is_err());
    assert!(add("http://conta.exemplo.com:8080/", "u", "Publico porta", "senha").is_err());
    assert!(add("ftp://exemplo.com/", "u", "FTP", "senha").is_err());
    assert!(add("javascript:alert(1)", "u", "JS", "senha").is_err());
    assert!(add("http://*.exemplo.com", "u", "Curinga HTTP", "senha").is_err());
}

#[test]
fn origin_matches_mesma_origem_e_recusa_outra() {
    assert!(origin_matches("https://a.com", "https://a.com/login?next=/home"));
    assert!(origin_matches("https://a.com", "https://A.COM:443/"));
    assert!(!origin_matches("https://a.com", "https://a.com.evil.io/"));
    assert!(!origin_matches("https://a.com", "https://sub.a.com/"));
    assert!(!origin_matches("https://a.com", "https://evil-a.com/"));
    assert!(!origin_matches("https://a.com", "http://a.com/"));
    assert!(!origin_matches("https://a.com", "https://a.com:8443/"));
    assert!(!origin_matches("https://a.com", "https://a.com@evil.com/login"));
    assert!(origin_matches("http://localhost:3000", "http://localhost:3000/login"));
    assert!(!origin_matches("http://localhost:3000", "http://localhost:3001/login"));
}

#[test]
fn curinga_aceita_subdominio_so_com_asterisco() {
    assert!(!origin_matches("https://exemplo.com", "https://app.exemplo.com/login"));
    assert!(origin_matches("*.exemplo.com", "https://app.exemplo.com/login"));
    assert!(origin_matches("*.exemplo.com", "https://a.b.exemplo.com/login"));
    assert!(origin_matches("*.exemplo.com", "https://exemplo.com/login"));
    assert!(origin_matches("https://*.exemplo.com", "https://app.exemplo.com/login"));
    assert!(!origin_matches("*.exemplo.com", "https://exemplo.com.evil.io/"));
    assert!(!origin_matches("*.exemplo.com", "https://meuexemplo.com/"));
    assert!(!origin_matches("*.exemplo.com", "http://app.exemplo.com/login"));
    assert!(!origin_matches("*.com", "https://qualquer.com/"));
    assert!(!origin_matches("*.com.br", "https://banco.com.br/"));

    setup_isolated_vault();
    let wild = add("*.Exemplo.com", "u", "Wildcard", "senha-wild")
        .expect("curinga de domínio registrável permitido");
    assert_eq!(wild.origin, "*.exemplo.com");
    assert!(add("*.com", "u", "TLD", "senha").is_err());
    assert!(add("*.com.br", "u", "Public suffix", "senha").is_err());
}

#[test]
fn remover_apaga_senha_do_keyring() {
    let service = setup_isolated_vault();
    let entry = add("https://site.exemplo.com", "ton", "Site", "senha-para-apagar")
        .expect("deve adicionar");
    assert!(password_for_fill(&entry.id).is_ok());

    remove(&entry.id).expect("deve remover");
    assert!(list().expect("lista após remoção").is_empty());
    assert!(
        password_for_fill(&entry.id).is_err(),
        "a senha não pode mais existir no keyring após remove()"
    );
    assert!(
        !TEST_KEYRING
            .lock()
            .unwrap()
            .contains_key(&(service, pw_key(&entry.id))),
        "a entrada pw:<id> deve ter sido removida do keyring"
    );
}

#[test]
fn secret_for_fill_recusa_origem_diferente() {
    setup_isolated_vault();
    let entry = add("https://banco.exemplo.com", "ton", "Banco", "senha-banco")
        .expect("deve adicionar");

    let err = secret_for_fill(&entry.id, "https://banco.exemplo.com.phish.io/login")
        .expect_err("origem diferente deve ser recusada");
    assert!(
        !err.contains("senha-banco"),
        "erro nunca pode vazar a senha"
    );

    let ok = secret_for_fill(&entry.id, "https://banco.exemplo.com/entrar")
        .expect("mesma origem deve liberar a senha para preenchimento");
    assert_eq!(ok.as_str(), "senha-banco");

    let updated = list().expect("lista").into_iter().next().expect("entrada");
    assert!(
        updated.last_used_at.is_some(),
        "uso bem-sucedido atualiza last_used_at"
    );
}

#[test]
fn atualizar_e_permissoes_de_agente() {
    setup_isolated_vault();
    let entry = add("https://portal.exemplo.com", "antigo", "Antigo", "senha-1")
        .expect("adiciona");
    let updated = update(&entry.id, Some("novo"), Some("Novo rótulo"), Some("senha-2"))
        .expect("atualiza");
    assert_eq!(updated.username, "novo");
    assert_eq!(updated.label, "Novo rótulo");
    assert_eq!(password_for_fill(&entry.id).unwrap().as_str(), "senha-2");

    assert!(!is_allowed(&entry.id, "tab-1"));
    allow_agent(&entry.id, "tab-1").expect("permite agente");
    assert!(is_allowed(&entry.id, "tab-1"));
    revoke_agent(&entry.id, "tab-1").expect("revoga agente");
    assert!(!is_allowed(&entry.id, "tab-1"));
}
