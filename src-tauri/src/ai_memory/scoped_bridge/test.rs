use super::*;
#[test]
fn carimba_recusa_divergencia_e_todas_as_rotas_globais() {
    for tool in TOOLS {
        let mut request = json!({"method":"tools/call","params":{"name":tool,"arguments":{}}});
        stamp(&mut request, "w", "p").unwrap();
        assert_eq!(request["params"]["arguments"]["workspace"], "w");
        assert_eq!(request["params"]["arguments"]["project"], "p");
        for bad in [
            json!({"workspace":"outro"}),
            json!({"project":"outro"}),
            json!({"global":true}),
            json!({"scope":"global"}),
            json!({"scope":"profile"}),
            json!({"scopes":[{"workspace":"outro","project":"x"}]}),
        ] {
            request["params"]["arguments"] = bad;
            assert!(stamp(&mut request, "w", "p").is_err());
        }
    }
    let mut unknown =
        json!({"method":"tools/call","params":{"name":"memory_delete_page","arguments":{}}});
    assert!(stamp(&mut unknown, "w", "p").is_err());
}
#[test]
fn configs_preservam_mcp_do_ade_e_apontam_ao_intermediario() {
    let env = std::collections::HashMap::from([(
        "OPENCODE_CONFIG_CONTENT".into(),
        json!({"mcp":{"ags":{"type":"local","command":["ags","mcp"]}}}).to_string(),
    )]);
    let plan = crate::ai_memory::tabs::scoped_plan(
        Path::new("/ags"),
        Path::new("/repo"),
        "opencode",
        &env,
        "w",
        "p",
    )
    .unwrap();
    let value: Value = serde_json::from_str(&plan.env["OPENCODE_CONFIG_CONTENT"]).unwrap();
    assert_eq!(value["mcp"]["ags"]["command"][1], "mcp");
    assert_eq!(value["mcp"]["ai-memory"]["command"][1], "ai-memory-bridge");
    let plan = crate::ai_memory::tabs::scoped_plan(
        Path::new("/ags"),
        Path::new("/repo"),
        "codex",
        &env,
        "w",
        "p",
    )
    .unwrap();
    assert!(plan.args[3].contains("ai-memory-bridge"));
    assert!(!plan.args.iter().any(|a| a.contains("mcp-bridge")));
}
#[cfg(unix)]
#[tokio::test]
async fn bridge_fake_recebe_carimbo_filtra_tools_e_recolhe_pid_ao_fechar_cliente() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("ade-scoped-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let fake = root.join("bridge");
    std::fs::write(&fake, "#!/bin/sh\nprintf '%s' \"$$\" > pid\nwhile IFS= read -r line; do printf '%s\\n' \"$line\" >> requests; printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"memory_recent\"},{\"name\":\"memory_delete_page\"}]}}'; done\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (mut client, input) = tokio::io::duplex(8192);
    let (output, response) = tokio::io::duplex(8192);
    let task = serve_with(&fake, &root, "w", "p", input, output);
    let client_task = async {
        let mut response = BufReader::new(response);
        for bad in [json!({"workspace":"wrong"}), json!({"global":true})] {
            send(&mut client, &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_recent","arguments":bad}})).await.unwrap();
            let rejected = line(&mut response, &mut Vec::new()).await.unwrap().unwrap();
            assert_eq!(rejected["error"]["code"], -32602);
        }
        client.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_recent\",\"arguments\":{}}}\n").await.unwrap();
        let result = line(&mut response, &mut Vec::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["result"]["tools"].as_array().unwrap().len(), 1);
        drop(client);
    };
    let (result, ()) = tokio::join!(task, client_task);
    result.unwrap();
    let request: Value = serde_json::from_str(
        std::fs::read_to_string(root.join("requests"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(request["params"]["arguments"]["project"], "p");
    let pid: i32 = std::fs::read_to_string(root.join("pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        !crate::util::spawn::hidden_command("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn mensagem_fragmentada_sobrevive_cancelamento_do_select() {
    let (mut writer, reader) = tokio::io::duplex(1024);
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    writer.write_all(b"{\"id\":").await.unwrap();
    tokio::select! {
        biased;
        _ = line(&mut reader, &mut bytes) => panic!("Não deveria concluir sem newline"),
        _ = std::future::ready(()) => {},
    }
    assert_eq!(bytes, b"{\"id\":");
    writer.write_all(b"1}\n").await.unwrap();
    assert_eq!(
        line(&mut reader, &mut bytes).await.unwrap().unwrap()["id"],
        1
    );
}

#[test]
fn projeto_ambiguo_ou_ausente_nao_habilita_injecao() {
    let projects: Vec<crate::ai_memory::types::Project> = serde_json::from_value(json!([
        {"workspace_name":"w","project_name":"repo","page_count":0},
        {"workspace_name":"other","project_name":"repo","page_count":0}
    ])).unwrap();
    assert!(crate::ai_memory::tabs::unique_project(&projects, Path::new("/repo")).is_none());
    assert!(crate::ai_memory::tabs::unique_project(&projects, Path::new("/unknown")).is_none());
    assert_eq!(crate::ai_memory::tabs::unique_project(&projects[..1], Path::new("/repo")).unwrap().workspace_name, "w");
}

#[test]
fn projetos_reservados_nao_podem_virar_escopo_fixo() {
    for name in ["_global", " _GLOBAL ", "_profile", "_profile.user"] {
        assert!(reserved_project(name));
    }
    assert!(!reserved_project("repo"));
}
