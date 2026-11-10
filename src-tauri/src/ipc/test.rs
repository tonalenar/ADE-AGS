//! Tests del IPC: el formato del cable, la resolución de nombres que hace la CLI y la
//! instalación del binario.

use serde_json::json;

use super::commands::{
    init_prompt, match_account_id, match_preset_id, match_skill_ids, skill_names, InstalledSkill,
};
use super::install::{is_installed, target_dir};
use super::protocol::{arg_str, Handshake, Request, Response, PROTOCOL_VERSION};

// ── Handshake con varias instancias ─────────────────────────────

/// Con dos instancias abiertas, el `ipc.json` global solo se reescribe si falta o si es de
/// una que ya murió: el de otra viva se respeta (cada una tiene el suyo para sus agentes).
#[test]
fn el_handshake_global_solo_se_recupera_si_quedo_huerfano() {
    use super::server::global_needs_rewrite;
    let hs = |pid| Handshake { port: 1, token: "t".into(), pid, protocol: PROTOCOL_VERSION, socket: None };
    assert!(global_needs_rewrite(None, 7, |_| true), "borrado por otra instancia al cerrarse");
    assert!(!global_needs_rewrite(Some(&hs(7)), 7, |_| false), "es el propio");
    assert!(!global_needs_rewrite(Some(&hs(8)), 7, |_| true), "otra instancia viva");
    assert!(global_needs_rewrite(Some(&hs(8)), 7, |_| false), "otra instancia que ya murió");
}

/// Cada instancia tiene su handshake al lado del global, con su PID en el nombre.
#[test]
fn cada_instancia_tiene_su_propio_handshake() {
    use super::protocol::{handshake_path, instance_handshake_path};
    let own = instance_handshake_path(4242);
    assert_eq!(own.file_name().unwrap(), "4242.json");
    assert_eq!(own.parent().unwrap().parent(), handshake_path().parent());
    assert_ne!(own, instance_handshake_path(4243));
}

// ── Formato del cable ───────────────────────────────────────────

/// El handshake y las requests son el contrato entre dos binarios que se compilan juntos
/// pero corren por separado: tienen que sobrevivir el ida y vuelta. Y `args` es opcional —
/// un comando sin flags no debería tener que mandar un objeto vacío explícito.
#[test]
fn el_formato_del_cable_sobrevive_el_ida_y_vuelta() {
    let hs = Handshake { port: 45123, token: "tok".into(), pid: 42, protocol: PROTOCOL_VERSION, socket: None };
    let back: Handshake = serde_json::from_str(&serde_json::to_string(&hs).unwrap()).unwrap();
    assert_eq!(back.port, 45123);
    assert_eq!(back.token, "tok");
    assert_eq!(back.protocol, PROTOCOL_VERSION);
    assert_eq!(back.socket, None);
    let with_socket = Handshake { socket: Some("/tmp/ags.sock".into()), ..hs };
    let encoded = serde_json::to_string(&with_socket).unwrap();
    assert!(encoded.contains("/tmp/ags.sock"));
    let decoded: Handshake = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded.socket.as_deref(), Some("/tmp/ags.sock"));
    let legacy: Handshake = serde_json::from_str(r#"{"port":1,"token":"t","pid":2,"protocol":1}"#).unwrap();
    assert_eq!(legacy.socket, None);

    let req = Request {
        token: "tok".into(),
        command: "tab.create".into(),
        args: json!({ "cwd": "/repo", "skills": ["a", "b"] }),
    };
    let back: Request = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
    assert_eq!(back.command, "tab.create");
    assert_eq!(back.args["skills"][1], "b");

    let sin_args: Request =
        serde_json::from_str(r#"{"token":"t","command":"tab.list"}"#).unwrap();
    assert!(sin_args.args.is_null());
}

/// Las respuestas omiten el campo que no aplica, para que la CLI pueda distinguir
/// "sin datos" de "hubo error" sin mirar `ok`.
#[test]
fn las_respuestas_omiten_el_campo_que_no_aplica() {
    let ok = serde_json::to_string(&Response::ok(json!({ "tabs": [] }))).unwrap();
    assert!(ok.contains("\"data\""));
    assert!(!ok.contains("\"error\""));

    let err = serde_json::to_string(&Response::err("no existe")).unwrap();
    assert!(err.contains("\"error\":\"no existe\""));
    assert!(!err.contains("\"data\""));
}

#[test]
fn un_argumento_faltante_nombra_el_flag_que_se_olvido() {
    let err = arg_str(&json!({}), "cwd").unwrap_err();
    assert_eq!(err, "Falta o argumento --cwd");
    assert_eq!(arg_str(&json!({ "cwd": "/x" }), "cwd").unwrap(), "/x");
}

// ── Resolución de nombres ───────────────────────────────────────

fn presets() -> Vec<(String, String)> {
    vec![("p1".into(), "entorno conda".into()), ("p2".into(), "node del proyecto".into())]
}

/// El texto de `--pre` se resuelve contra los guardados sin distinguir mayúsculas ni
/// espacios de más; si no coincide con ninguno se ejecuta tal cual.
#[test]
fn el_nombre_del_preset_se_resuelve_sin_distinguir_mayusculas() {
    assert_eq!(match_preset_id(&presets(), "Entorno Conda").unwrap(), "p1");
    assert_eq!(match_preset_id(&presets(), "  entorno conda  ").unwrap(), "p1");
    assert!(match_preset_id(&presets(), "nvm use").is_err(), "sin coincidencia, es literal");
}

/// El error tiene que decir qué SÍ existe: quien escribió mal un nombre no debería
/// tener que ir a la UI a mirarlo. Y sin nada guardado, dónde crearlos.
#[test]
fn un_preset_inexistente_lista_los_que_hay() {
    let err = match_preset_id(&presets(), "conda").unwrap_err();
    assert!(err.contains("entorno conda"), "{err}");
    assert!(err.contains("node del proyecto"), "{err}");

    let err = match_preset_id(&[], "conda").unwrap_err();
    assert!(err.contains("Configuración"), "{err}");
}

/// Cuentas de prueba: `(id, agente, nombre)`, como salen de `agent_accounts`.
fn accounts() -> Vec<(String, String, String)> {
    vec![
        ("a1".into(), "claude-code".into(), "trabajo".into()),
        ("a2".into(), "claude-code".into(), "personal".into()),
        ("a3".into(), "opencode".into(), "trabajo".into()),
    ]
}

/// Una cuenta se resuelve por nombre o por id, sin distinguir mayúsculas, y siempre
/// dentro de SU TUI: el mismo nombre en otra TUI es otra cuenta.
#[test]
fn una_cuenta_se_resuelve_dentro_de_su_propia_tui() {
    assert_eq!(match_account_id(&accounts(), "claude-code", "trabajo").unwrap(), "a1");
    assert_eq!(match_account_id(&accounts(), "opencode", "trabajo").unwrap(), "a3");
    assert_eq!(match_account_id(&accounts(), "claude-code", "A1").unwrap(), "a1");
    assert_eq!(match_account_id(&accounts(), "claude-code", "Personal").unwrap(), "a2");
}

/// El error más fácil de cometer, y el que en silencio abriría la tab con la cuenta
/// del sistema: pedir una cuenta que existe pero es de otra TUI.
#[test]
fn una_cuenta_de_otro_agente_se_rechaza_por_nombre() {
    let err = match_account_id(&accounts(), "opencode", "personal").unwrap_err();
    assert!(err.contains("é de 'claude-code'"), "{err}");
}

/// Un nombre desconocido lista las que hay; si esa TUI no tiene ninguna, explica dónde
/// se crean.
#[test]
fn una_cuenta_desconocida_explica_que_opciones_existen() {
    let err = match_account_id(&accounts(), "claude-code", "qa").unwrap_err();
    assert!(err.contains("trabajo") && err.contains("personal"), "{err}");

    let err = match_account_id(&accounts(), "codex", "qa").unwrap_err();
    assert!(err.contains("não tem nenhuma conta criada"), "{err}");
}

fn skill(id: &str, name: &str, author: Option<&str>, registry: Option<&str>) -> InstalledSkill {
    InstalledSkill {
        id: id.to_string(),
        name: name.to_string(),
        author: author.map(str::to_string),
        registry_name: registry.map(str::to_string),
    }
}

fn installed() -> Vec<InstalledSkill> {
    vec![
        skill("11111111-aaaa", "git-helper", None, None),
        skill("22222222-bbbb", "Testing Pro", None, None),
    ]
}

/// `--skills` toma NOMBRES, que es lo único que un humano (o un agente) puede escribir:
/// el id es un UUID. Pasarlos derecho a `attach_skill` no adjuntaba nada.
#[test]
fn los_nombres_de_skill_se_resuelven_a_sus_ids() {
    assert_eq!(
        match_skill_ids(&installed(), &["git-helper".to_string()]).unwrap(),
        vec!["11111111-aaaa"]
    );

    let requested = vec!["TESTING pro".to_string(), "11111111-aaaa".to_string()];
    assert_eq!(
        match_skill_ids(&installed(), &requested).unwrap(),
        vec!["22222222-bbbb", "11111111-aaaa"],
        "sin distinguir mayúsculas, y el id derecho también vale"
    );
}

/// Un nombre inventado tiene que fallar diciendo qué SÍ hay: la alternativa era una
/// tab creada en silencio sin las skills que se pidieron.
#[test]
fn una_skill_desconocida_nombra_las_instaladas() {
    let err = match_skill_ids(&installed(), &["no-existe".to_string()]).unwrap_err();
    assert!(err.contains("no-existe"));
    assert!(err.contains("git-helper") && err.contains("Testing Pro"));

    let err = match_skill_ids(&[], &["git-helper".to_string()]).unwrap_err();
    assert!(err.contains("skill install"), "el error tiene que decir el próximo paso: {err}");
}

/// Las dos grafías del flag son el mismo para el usuario, y un prompt en blanco no
/// debería disparar toda la espera de arranque para no mandar nada.
#[test]
fn el_flag_del_prompt_inicial_acepta_las_dos_grafias_e_ignora_los_blancos() {
    assert_eq!(init_prompt(&json!({ "initprompt": "hola" })).as_deref(), Some("hola"));
    assert_eq!(init_prompt(&json!({ "initPrompt": "hola" })).as_deref(), Some("hola"));
    assert_eq!(init_prompt(&json!({ "initPrompt": "   " })), None);
    assert_eq!(init_prompt(&json!({})), None);
}

#[test]
fn los_nombres_de_skill_se_leen_del_array_que_manda_la_cli() {
    assert_eq!(
        skill_names(&json!({ "skills": ["a", "b"] })),
        Some(vec!["a".to_string(), "b".to_string()])
    );
    assert_eq!(skill_names(&json!({ "skills": [] })), None);
    assert_eq!(skill_names(&json!({})), None);
}

// ── Instalación del binario ─────────────────────────────────────

/// Instalar la CLI no puede pedir permisos de administrador.
#[test]
fn el_destino_es_una_carpeta_del_usuario() {
    let dir = target_dir().expect("debería resolverse en cualquier sistema con HOME");
    let home = dirs::home_dir().unwrap();
    assert!(dir.starts_with(&home), "el destino tiene que estar dentro del home del usuario");
}

/// Un symlink que quedó de una instalación anterior apunta a un binario viejo: tiene que
/// pedir reinstalación en vez de darse por instalado.
#[test]
fn un_symlink_que_apunta_a_otro_lado_no_cuenta_como_instalado() {
    let base = std::env::temp_dir().join(format!("cc-cli-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();

    let current = base.join("ags-nuevo");
    let old = base.join("ags-viejo");
    std::fs::write(&current, b"#!/bin/sh\n").unwrap();
    std::fs::write(&old, b"#!/bin/sh\n").unwrap();

    let link = base.join("link");
    assert!(!is_installed(&link, Some(&current)), "sin nada en el destino, no está instalado");

    match symlink::symlink_file(&old, &link) {
        Ok(()) => {
            assert!(!is_installed(&link, Some(&current)));
            // No `remove_symlink_auto`: en Windows el crate `symlink` abre el link sin
            // FILE_FLAG_OPEN_REPARSE_POINT, ve el archivo destino (no un reparse point) y
            // devuelve InvalidInput "path is not a symlink". Este link es de archivo, así
            // que `remove_file` lo quita en todas las plataformas.
            std::fs::remove_file(&link).unwrap();
            symlink::symlink_file(&current, &link).unwrap();
            assert!(is_installed(&link, Some(&current)));
        }
        // Windows sin privilegio de symlink: la instalación real es una copia, y un
        // archivo presente cuenta como instalado. No se puede fabricar el fixture del
        // symlink; el contrato de la copia sí se puede probar.
        Err(error) if error.raw_os_error() == Some(1314) => {
            std::fs::copy(&current, &link).unwrap();
            assert!(is_installed(&link, Some(&current)), "una copia del binario actual cuenta");
            std::fs::remove_file(&link).unwrap();
            assert!(!is_installed(&link, Some(&current)));
        }
        Err(error) => panic!("{error}"),
    }

    let _ = std::fs::remove_dir_all(&base);
}

/// EL bug: dos skills instaladas con el mismo nombre y autores distintos. Quedarse con la
/// primera que devuelva SQLite le monta a la tab una skill que el usuario no pidió, sin
/// decir nada. Tiene que fallar y explicar cómo desambiguar.
#[test]
fn un_nombre_ambiguo_es_un_error_y_no_una_ruleta() {
    let dos = vec![
        skill("aaa", "testing", Some("anthropics"), Some("anthropics/skills")),
        skill("bbb", "testing", Some("midudev"), Some("autoskills")),
    ];

    let err = match_skill_ids(&dos, &["testing".to_string()]).unwrap_err();
    assert!(err.contains("aaa") && err.contains("bbb"), "tiene que listar las dos: {err}");
    assert!(err.contains("anthropics") && err.contains("midudev"), "y sus autores: {err}");

    // Con el id no hay ambigüedad posible.
    assert_eq!(match_skill_ids(&dos, &["bbb".to_string()]).unwrap(), vec!["bbb"]);
}

/// Con una sola instalada con ese nombre no hay nada que preguntar.
#[test]
fn un_nombre_sin_homonimas_se_resuelve_derecho() {
    let una = vec![skill("aaa", "testing", Some("anthropics"), None)];
    assert_eq!(match_skill_ids(&una, &["TESTING".to_string()]).unwrap(), vec!["aaa"]);
}

// ── El contrato entre `ags` y el despachador ──────────────────

/// Los comandos que el binario `ags` sabe nombrar, sacados de sus propias tablas.
fn cli_commands() -> Vec<String> {
    let src = include_str!("../bin/cli.rs");
    let mut out = Vec::new();
    // `shortcut()`: `"skills" => Some("skill.list"),`
    for cap in src.split("Some(\"").skip(1) {
        if let Some(cmd) = cap.split('"').next() {
            if cmd.contains('.') {
                out.push(cmd.to_string());
            }
        }
    }
    // `positionals()`: `"skill.show" | "skill.edit" => &["skill"],`
    for line in src.lines() {
        let line = line.trim();
        if !line.contains("=> &[") {
            continue;
        }
        for part in line.split("=>").next().unwrap_or("").split('|') {
            let name = part.trim().trim_matches(|c| c == '"' || c == ' ');
            if name.contains('.') {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Los comandos que el despachador atiende, sacados de su `match`.
fn dispatched_commands() -> Vec<String> {
    include_str!("commands/dispatch.rs")
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix('"')?;
            let (name, tail) = rest.split_once('"')?;
            tail.trim_start().starts_with("=>").then(|| name.to_string())
        })
        .filter(|c| c.contains('.'))
        .collect()
}

#[test]
fn comandos_de_manutencao_nao_rodam_no_terminal_do_agente() {
    let compact = super::agent_maintenance_error("memory.compact").unwrap();
    let restore = super::agent_maintenance_error("workspace.restore").unwrap();
    assert!(compact.contains("interface"));
    assert_eq!(compact, restore);
    assert!(super::agent_maintenance_error("memory.export").is_none());
    assert!(super::agent_maintenance_error("memory.suggest").is_none());
    assert!(super::agent_maintenance_error("memory.search").is_none());
}

// ── F-01: decidir aprovação da Frota é só da pessoa, na tela ─────────────────────

/// Todos os arquivos de `src-tauri/src/ipc` (menos este de testes), com o caminho.
fn fontes_do_ipc() -> Vec<(String, String)> {
    fn andar(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                andar(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") && path.file_name().is_some_and(|n| n != "test.rs") {
                out.push((path.display().to_string(), std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    andar(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ipc"), &mut out);
    out
}

/// O servidor não consegue provar que quem chama o IPC não é um agente: o token está num
/// arquivo legível pelo mesmo usuário, o PID do par só prova o que É descendente (um
/// `setsid`/duplo fork/`open -a Terminal` sai da árvore) e o TCP não traz PID. Por isso a
/// recusa não depende do chamador: vale para a conversa por protocolo (`thread:<id>`), para
/// a aba de agente (`ADE_TAB_ID`), para o `ags mcp --task` da Frota, para o PID de um
/// descendente do PTY, para o PID de fora e para o TCP sem PID.
#[test]
fn aprovacao_da_frota_so_se_decide_na_tela_qualquer_chamador_do_ipc_e_recusado() {
    for command in ["approval.decide", "approval.list"] {
        let error = super::person_only_error(command).unwrap_or_else(|| panic!("{command} passou pelo IPC"));
        assert_eq!(error, super::APPROVAL_SCREEN_ONLY);
        assert!(error.contains("tela"), "a mensagem tem que mandar decidir pela tela: {error}");
    }
    // O agente pede (`run.approve`, bloqueia até a pessoa decidir) e conversa com o time pelo
    // canal próprio: nada disso é decidir a aprovação da Frota.
    for command in ["run.approve", "peer.pending", "chat.pending", "user.ask", "approval.other"] {
        assert!(super::person_only_error(command).is_none(), "{command} não deveria ser recusado por aqui");
    }
}

#[test]
fn o_despachador_recusa_a_decisao_antes_de_olhar_o_chamador_e_nao_tem_braco_para_ela() {
    let dispatch = include_str!("commands/dispatch.rs");
    let gate = dispatch.find("person_only_error(command)").expect("o despachador tem que chamar person_only_error");
    // Antes do `match`, da checagem de tarefa e de qualquer acesso ao banco.
    assert!(gate < dispatch.find("let result = match command").unwrap());
    assert!(gate < dispatch.find("guard_task").unwrap());
    assert!(!dispatch.contains("\"approval.decide\" =>") && !dispatch.contains("\"approval.list\" =>"));
}

#[test]
fn nenhum_caminho_do_ipc_decide_lista_nem_lembra_regra_de_aprovacao() {
    for (path, src) in fontes_do_ipc() {
        for proibido in ["decide_approval", "pending_approvals", "approval_decide", "approval_list", "remember_rule", "release_matching"] {
            assert!(!src.contains(proibido), "{path} chama {proibido}: decidir aprovação é só da tela");
        }
        // `mod.rs` define a recusa; `authz.rs` os classifica como `Person` (só a pessoa, pela tela), o que é a mesma recusa.
        if !path.ends_with("ipc/mod.rs") && !path.ends_with("ipc/authz.rs") {
            assert!(!src.contains("\"approval.decide\"") && !src.contains("\"approval.list\""), "{path} oferece approval.* pelo IPC");
        }
    }
    // Na tabela de autorização, os dois só aparecem como "só a pessoa, pela tela".
    let tabela = include_str!("authz.rs");
    assert!(tabela.contains("(\"approval.decide\", SCREEN_APPROVAL)") && tabela.contains("(\"approval.list\", SCREEN_APPROVAL)"));
    // O MCP também não tem tool para isso.
    assert!(!include_str!("mcp.rs").contains("approval_decide") && !include_str!("mcp.rs").contains("approval_list"));
    assert!(!include_str!("../../../src/features/orchestrator/cliBridge.ts").contains("approval.decide"));
}

#[test]
fn a_cli_explica_que_a_decisao_e_na_tela_e_nao_oferece_flags_para_decidir() {
    let cli = include_str!("../bin/cli.rs");
    let gate = cli.find("person_only_error(&command)").expect("a CLI tem que recusar antes de falar com o app");
    assert!(gate < cli.find("validate_usage(&command").unwrap());
    assert!(!cli.contains("\"approval.decide\" => &["), "sem posicional para um comando que não existe");
    assert!(!cli.contains("approval decide <id> --allow"), "o USAGE não pode ensinar a decidir pela CLI");
    assert!(cli.contains("approval list|decide") && cli.contains("só pela tela"));
}

#[test]
fn a_skill_diz_que_so_a_pessoa_decide_na_tela() {
    let skill = include_str!("../../../skills/ags-orchestrator/SKILL.md");
    assert!(skill.contains("Fleet approvals are decided by the person on the ADE screen"));
    assert!(!skill.contains("approval decide <id> --allow"));
    assert!(!skill.contains("`approval list`, `approval decide`"));
}

/// Que `ags` nombre un comando que el backend ya no atiende no rompe nada en compilación
/// —son dos tablas de strings, en archivos distintos— y solo se nota cuando alguien lo
/// ejecuta y recibe "Comando desconocido". Este test es lo que ata las dos puntas.
#[test]
fn todo_lo_que_la_cli_sabe_nombrar_lo_atiende_el_despachador() {
    let dispatched = dispatched_commands();
    assert!(dispatched.len() > 15, "no se pudieron leer los comandos del despachador");

    let huerfanos: Vec<String> =
        cli_commands().into_iter().filter(|c| !dispatched.contains(c) && !matches!(c.as_str(), "test.run" | "test.affected" | "test.status")).collect();
    assert!(huerfanos.is_empty(), "la CLI ofrece comandos que nadie atiende: {huerfanos:?}");
}

/// Y la contracara: un comando del backend que la ayuda de `ags` no menciona es un
/// comando que nadie va a encontrar.
#[test]
fn la_ayuda_de_la_cli_menciona_los_comandos_de_skills() {
    let src = include_str!("../bin/cli.rs");
    for verbo in ["skill show", "skill new", "skill edit", "skill install", "skill search"] {
        assert!(src.contains(verbo), "la ayuda no menciona '{verbo}'");
    }
}

// ── `ags mcp`: el puente MCP ──────────────────────────────────

use super::mcp::{browser_tool_names, orchestration_tool_names, serve, McpContext, OrchestrationPower};

/// Corre el servidor sobre una conversación entera y devuelve las respuestas y lo que se
/// le mandó a la app.
fn mcp_session(
    context: &McpContext,
    lines: &[serde_json::Value],
    reply: impl Fn(&str, &serde_json::Value) -> Result<serde_json::Value, String> + Sync,
) -> (Vec<serde_json::Value>, Vec<(String, serde_json::Value)>) {
    mcp_session_as(context, "", lines, reply)
}

/// Lo mismo, como lo ve un cliente que prefija los nombres de tool (OpenCode).
fn mcp_session_as(
    context: &McpContext,
    prefix: &str,
    lines: &[serde_json::Value],
    reply: impl Fn(&str, &serde_json::Value) -> Result<serde_json::Value, String> + Sync,
) -> (Vec<serde_json::Value>, Vec<(String, serde_json::Value)>) {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut output = Vec::new();
    let sent = std::sync::Mutex::new(Vec::new());
    serve(context, prefix, input.as_bytes(), &mut output, |command, mut payload| {
        // Cada llamada viaja con un `callId` único (para poder cancelarla); se prueba aparte
        // y acá se saca para comparar el resto del pedido tal cual.
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("callId");
        }
        let answer = reply(command, &payload);
        sent.lock().unwrap().push((command.to_string(), payload));
        answer
    })
    .unwrap();
    let sent = sent.into_inner().unwrap();
    let responses = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    (responses, sent)
}

fn tool_names(response: &serde_json::Value) -> Vec<String> {
    response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

fn call(id: u64, name: &str, arguments: serde_json::Value) -> serde_json::Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } })
}

/// Una tab interactiva no tiene broker: sus permisos los contesta la persona en la
/// terminal. Ofrecerle `approve_tool_use` sería una tool que el modelo podría llamar para
/// "aprobarse" algo a sí mismo.
#[test]
fn una_tab_ve_el_navegador_y_una_tarea_ademas_el_broker() {
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let (tab, _) = mcp_session(&McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None }, std::slice::from_ref(&list), |_, _| Ok(json!({})));
    let (task, _) = mcp_session(&McpContext::Task("t1".into()), &[list], |_, _| Ok(json!({})));

    let tab = tool_names(&tab[0]);
    let task = tool_names(&task[0]);
    assert!(!tab.contains(&"approve_tool_use".to_string()));
    assert!(tab.contains(&"browser_click".to_string()));
    assert_eq!(task[0], "approve_tool_use");
    let memory: Vec<_> = task.iter().filter(|name| name.starts_with("memory_")).collect();
    assert_eq!(memory.len(), 9);
    assert!(task.iter().any(|name| name == "memory_search"));
    assert!(task.iter().any(|name| name == "memory_open"));
    assert!(task.iter().any(|name| name == "memory_workspace_history"));
    assert!(!tab.iter().any(|name| name.starts_with("memory_")));
    let task_without_memory: Vec<_> = task[1..].iter().filter(|name| !name.starts_with("memory_")).cloned().collect();
    // As conversas do modo chat (`chat_*`) são só das abas: uma tarefa da frota não abre conversa.
    let chat: Vec<String> = tab.iter().filter(|name| name.starts_with("chat_")).cloned().collect();
    assert!(!task.iter().any(|name| name.starts_with("chat_")));
    assert!(!task.iter().any(|name| name == "harness_graph" || name == "delegate_agent"));
    // Os designs (`design_*`) também: abrir a tela de Design é coisa de aba.
    assert!(!task.iter().any(|name| name.starts_with("design_")));
    let tab_without_chat: Vec<_> = tab.iter().filter(|name| !name.starts_with("chat_") && !name.starts_with("design_") && !name.starts_with("device_") && *name != "sim_act" && *name != "desk_act" && *name != "harness_graph" && *name != "delegate_agent").cloned().collect();
    let task_only: Vec<_> = task_without_memory.iter().filter(|name| !tab_without_chat.contains(name)).collect();
    let tab_only: Vec<_> = tab_without_chat.iter().filter(|name| !task_without_memory.contains(name)).collect();
    assert_eq!(task_without_memory, tab_without_chat, "só na tarefa: {task_only:?}; só na aba: {tab_only:?}");

    // Lo que se permite de antemano en `--allowedTools` es exactamente lo que se ofrece,
    // menos lo que saca datos de la máquina (subir un archivo, correr código en la página):
    // un nombre de más no hace nada, uno de menos deja una tool pidiendo permiso por cada uso.
    let offered: Vec<String> = tab.iter().map(|n| format!("mcp__ags__{n}")).collect();
    let browser: Vec<String> = offered
        .iter()
        .filter(|n| n.contains("__browser_") && !n.ends_with("__browser_upload") && !n.ends_with("__browser_eval"))
        .cloned()
        .collect();
    assert_eq!(browser_tool_names(), browser);
    assert!(offered.iter().any(|n| n.ends_with("__browser_upload")), "browser_upload sigue ofreciéndose");
    let all_powers = [OrchestrationPower::Read, OrchestrationPower::Note, OrchestrationPower::Delivery, OrchestrationPower::Spawn];
    let orchestration = orchestration_tool_names(&all_powers);
    assert!(!orchestration.is_empty());
    assert!(orchestration.iter().all(|n| offered.contains(n) || n.contains("__memory_")), "{orchestration:?}");
    // Preguntarle algo al usuario va para los dos lados y no es ni navegador ni orquestación.
    assert!(tab.contains(&super::mcp::ASK_TOOL.to_string()));
    // Las de git remoto: todas se ofrecen, y las que se aprueban solas son solo las que leen.
    let git: Vec<String> = offered.iter().filter(|n| n.contains("__git_")).cloned().collect();
    assert_eq!(git.len(), crate::forge::tools::GIT_TOOLS.len());
    let git_read = super::mcp::git_read_tool_names();
    assert!(git_read.iter().all(|n| git.contains(n)), "{git_read:?}");
    assert!(!git_read.iter().any(|n| n.ends_with("git_push") || n.ends_with("_create")));
    // + 2: `browser_upload` y `browser_eval`, que se ofrecen pero no se aprueban solas.
    // + chat: as do modo chat, que se oferecem nas abas e não se aprovam sozinhas.
    // + design: as da tela de Design, idem.
    let design = tab.iter().filter(|name| name.starts_with("design_")).count();
    // + computer use: `sim_act` e `desk_act`, só das abas e conversas (uma tarefa da frota não tem quem a identifique).
    let computer_use: Vec<_> = tab.iter().filter(|name| *name == "sim_act" || *name == "desk_act").collect();
    assert_eq!(computer_use.len(), 2);
    assert!(!task.iter().any(|name| name == "sim_act" || name == "desk_act"));
    let devices: Vec<_> = tab.iter().filter(|name| name.starts_with("device_")).collect();
    assert_eq!(devices.len(), 3);
    assert!(!task.iter().any(|name| name.starts_with("device_")));
    assert_eq!(browser.len() + 2 + orchestration.len() - memory.len() + git.len() + 1 + chat.len() + 2 + design + computer_use.len() + devices.len(), offered.len());
}

/// OpenCode registra las tools de un servidor MCP con el nombre del servidor de prefijo
/// (`ags_browser_click`). El nombre que este servidor PUBLICA va pelado —el
/// prefijo lo pone la TUI, y ponerlo también acá daría `ags_ags_…`—, pero
/// todo lo que el modelo LEE tiene que nombrarlas como él las va a poder escribir: si no,
/// lee "usá browser_marked" y lo que tiene se llama de otra forma.
#[test]
fn con_un_cliente_que_prefija_los_nombres_el_texto_los_prefija_igual() {
    let lines = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    ];
    let cwd = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None };
    let (pelado, _) = mcp_session(&cwd, &lines, |_, _| Ok(json!({})));
    let (opencode, _) = mcp_session_as(&cwd, "ags_", &lines, |_, _| Ok(json!({})));

    // Los nombres publicados no cambian: son los del servidor.
    assert_eq!(tool_names(&pelado[1]), tool_names(&opencode[1]));

    let instructions = opencode[0]["result"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("ags_browser_marked"), "{instructions}");
    assert!(instructions.contains("ags_browser_click/ags_browser_type"), "{instructions}");
    assert!(instructions.contains("ags_run_plan"), "{instructions}");
    // Ni dos veces, ni sobre algo que no es una tool.
    assert!(!instructions.contains("ags_ags_"), "{instructions}");
    assert!(instructions.contains("ADE AGS"), "{instructions}");

    // Las descripciones también: `browser_pick` se nombra adentro de la de `browser_marked`.
    let description = |list: &serde_json::Value, name: &str| -> String {
        list["result"]["tools"].as_array().unwrap().iter()
            .find(|t| t["name"] == name).unwrap()["description"].as_str().unwrap().to_string()
    };
    // Y las de los parámetros, que nombran tools igual ("un ref de browser_snapshot").
    let target = opencode[1]["result"]["tools"].as_array().unwrap().iter()
        .find(|t| t["name"] == "browser_click").unwrap()["inputSchema"]["properties"]["target"]["description"]
        .as_str().unwrap().to_string();
    assert!(target.contains("ags_browser_snapshot"), "{target}");

    // Y sin prefijo el texto queda EXACTAMENTE como está escrito en la tabla.
    assert!(!pelado[0]["result"]["instructions"].as_str().unwrap().contains("ags_browser"));
    assert!(!description(&pelado[1], "browser_marked").contains("ags_"));
}

/// El servidor como lo escribe OpenCode: el comando ENTERO en un arreglo, bajo `"mcp"`, y
/// `"ask"` para las tools que en Claude Code no se aprueban solas.
#[test]
fn la_config_de_opencode_lleva_el_servidor_y_pide_permiso_para_lo_que_escribe() {
    let raw = super::mcp::opencode_config_content(
        "/opt/cc/ags",
        &["mcp", "--cwd", "/p", "--tab", "t1", "--prefix", "ags_"],
        "ags_",
    );
    let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut keys: Vec<_> = config.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["mcp", "permission"]);
    let server = &config["mcp"]["ags"];
    assert_eq!(server["type"], "local");
    assert_eq!(server["enabled"], true);
    assert_eq!(
        server["command"],
        json!(["/opt/cc/ags", "mcp", "--cwd", "/p", "--tab", "t1", "--prefix", "ags_"])
    );
    assert!(server["timeout"].as_u64().unwrap() > 60_000);

    let permission = config["permission"].as_object().unwrap();
    for asks in ["ags_git_push", "ags_git_pr_create", "ags_task_add", "ags_run_plan"] {
        assert_eq!(permission.get(asks), Some(&json!("ask")), "{asks}");
    }
    // Lo que se aprueba solo en Claude Code tampoco pregunta acá; y nada fuera de nuestras
    // tools (la regla global del usuario no se toca).
    for free in ["ags_browser_click", "ags_git_pr_list", "ags_ask_user", "ags_fact_add", "ags_device_list", "ags_device_shot"] {
        assert!(!permission.contains_key(free), "{free}");
    }
    assert!(permission.keys().all(|k| k.starts_with("ags_")));
}

/// Una sola regla para las dos TUIs: lo que Claude Code aprueba solo es exactamente lo que
/// OpenCode no pregunta.
#[test]
fn claude_y_opencode_aprueban_solas_las_mismas_tools() {
    let raw = super::mcp::opencode_config_content("/c", &[], "");
    let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let asks: Vec<&String> = config["permission"].as_object().unwrap().keys().collect();
    for name in asks {
        assert!(!super::mcp::auto_approved(name), "{name}");
    }
    assert!(super::mcp::auto_approved("browser_click"));
    assert!(!super::mcp::auto_approved("git_push"));
    // Sacan datos de la máquina hacia una página que puede ser cualquiera: las aprueba la persona.
    assert!(!super::mcp::auto_approved("browser_upload"));
    assert!(!super::mcp::auto_approved("browser_eval"));
}

/// Cada tool lleva sus anotaciones, y dicen la verdad: las de lectura no escriben, y
/// `destructiveHint` (que por la especificación vale `true` si falta) se dice siempre que
/// la tool escribe.
#[test]
fn cada_tool_declara_si_lee_escribe_o_destruye() {
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let (tab, _) = mcp_session(&McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None }, &[list], |_, _| Ok(json!({})));
    let tools = tab[0]["result"]["tools"].as_array().unwrap();
    let find = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap()["annotations"].clone();
    for t in tools {
        let a = &t["annotations"];
        assert!(a["readOnlyHint"].is_boolean(), "{}", t["name"]);
        if a["readOnlyHint"] == false {
            assert!(a["destructiveHint"].is_boolean(), "{}", t["name"]);
        }
    }
    assert_eq!(find("browser_snapshot")["readOnlyHint"], true);
    assert_eq!(find("git_pr_list")["readOnlyHint"], true);
    assert_eq!(find("git_push")["readOnlyHint"], false);
    assert_eq!(find("git_push")["destructiveHint"], false);
    assert_eq!(find("task_cancel")["destructiveHint"], true);
    assert_eq!(find("browser_eval")["destructiveHint"], true);
    assert_eq!(find("device_list")["readOnlyHint"], true);
    assert_eq!(find("device_shot")["readOnlyHint"], true);
    assert_eq!(find("device_action")["readOnlyHint"], false);
    assert_eq!(find("device_action")["destructiveHint"], true);
    assert_eq!(find("git_push")["openWorldHint"], true);
    assert_eq!(find("fact_add")["openWorldHint"], false);
}

/// Lanzar o parar agentes gasta plata: eso nunca va permitido de antemano a alguien que
/// solo debería leer. Mirar el run y dejar un hecho, sí.
#[test]
fn las_tools_que_lanzan_agentes_no_se_permiten_con_las_de_lectura() {
    let light = orchestration_tool_names(&[OrchestrationPower::Read, OrchestrationPower::Note]);
    for spawning in ["run_plan", "task_add", "task_cancel", "task_reroute"] {
        assert!(!light.iter().any(|n| n.ends_with(spawning)), "{spawning} no puede ir con las de lectura");
    }
    for reading in ["agent_roster", "task_status", "task_result", "run_await", "facts_read", "fact_add"] {
        assert!(light.iter().any(|n| n.ends_with(reading)), "falta {reading}");
    }
}

/// Una tool de orquestación viaja con quién la pide y sus argumentos tal cual: la app
/// decide sobre qué run actúa, no el agente.
#[test]
fn una_tool_de_orquestacion_viaja_con_quien_la_pide() {
    let (responses, sent) = mcp_session(
        &McpContext::Task("t-3".into()),
        &[call(5, "run_await", json!({ "timeout_s": 60, "run_id": "otro" }))],
        |_, _| Ok(json!({ "text": "Terminaron: api (done)" })),
    );
    assert_eq!(sent[0].0, "run.await");
    assert_eq!(sent[0].1, json!({ "taskId": "t-3", "args": { "timeout_s": 60, "run_id": "otro" } }));
    assert_eq!(responses[0]["result"]["content"][0]["text"], "Terminaron: api (done)");
}

#[test]
fn task_handoff_uses_existing_mcp_task_scope_and_delivery_permission() {
    let body=json!({"handoff":{"version":1,"summary":"done"}});
    let (responses,sent)=mcp_session(&McpContext::Task("worker-1".into()),&[call(5,"task_handoff",body.clone())],|_,_|Ok(json!({"text":"saved"})));
    assert_eq!(sent[0].0,"run.handoff");
    assert_eq!(sent[0].1,json!({"taskId":"worker-1","args":body}));
    assert_eq!(responses[0]["result"]["content"][0]["text"],"saved");
    assert!(super::mcp::auto_approved("task_handoff"));
    assert!(!orchestration_tool_names(&[OrchestrationPower::Read,OrchestrationPower::Note,OrchestrationPower::Spawn]).iter().any(|name|name.ends_with("task_handoff")));
    assert!(orchestration_tool_names(&[OrchestrationPower::Delivery]).iter().any(|name|name.ends_with("task_handoff")));
}

#[test]
fn una_tool_del_navegador_viaja_como_browser_run_con_su_carpeta() {
    let (responses, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/home/u/proyecto".into(), tab: None, mission: None, role: None },
        &[
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            call(7, "browser_type", json!({ "target": "e3", "text": "ana@x.com", "submit": true })),
        ],
        |_, _| Ok(json!({ "text": "{\"typed\":\"input#email\"}" })),
    );

    // La notificación no lleva respuesta: contestarla rompe a los clientes estrictos.
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["id"], 7);
    assert_eq!(responses[0]["result"]["content"][0]["text"], "{\"typed\":\"input#email\"}");
    assert!(responses[0]["result"].get("isError").is_none());

    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "browser.run");
    assert_eq!(
        sent[0].1,
        json!({ "cwd": "/home/u/proyecto", "request": { "op": "type", "target": "e3", "text": "ana@x.com", "submit": true } })
    );
}

#[test]
fn browser_act_viaja_como_browser_run_com_o_objetivo_e_os_valores() {
    let (responses, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/home/u/proyecto".into(), tab: None, mission: None, role: None },
        &[
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            call(3, "browser_act", json!({ "goal": "fazer login e abrir o carrinho", "fills": ["Username=ana"], "steps": 6 })),
        ],
        |_, _| Ok(json!({ "text": "act: FEITO" })),
    );
    assert_eq!(responses[0]["result"]["content"][0]["text"], "act: FEITO");
    assert_eq!(sent[0].0, "browser.run");
    assert_eq!(
        sent[0].1["request"],
        json!({ "op": "act", "goal": "fazer login e abrir o carrinho", "fills": ["Username=ana"], "steps": 6 })
    );
}

#[test]
fn browser_act_aceita_timeout_e_o_prazo_e_o_mesmo_do_portal_act() {
    let (_, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None },
        &[call(3, "browser_act", json!({ "goal": "abrir o carrinho", "timeout": 300 }))],
        |_, _| Ok(json!({ "text": "ok" })),
    );
    assert_eq!(sent[0].1["request"]["timeout"], 300);
    // O mesmo padrão e a mesma faixa para a CLI (`portal act`, `sim act`, `desk act`) e o MCP.
    assert_eq!(super::mcp::act_timeout_secs(None), 115);
    assert_eq!(super::mcp::act_timeout_secs(Some(&json!(300))), 300);
    assert_eq!(super::mcp::act_timeout_secs(Some(&json!("300"))), 300);
    assert_eq!(super::mcp::act_timeout_secs(Some(&json!(5))), 10);
    assert_eq!(super::mcp::act_timeout_secs(Some(&json!(99_999))), 1800);
    let (list, _) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None },
        &[json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })],
        |_, _| Ok(json!({})),
    );
    let act = list[0]["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "browser_act").unwrap().clone();
    assert!(act["inputSchema"]["properties"]["timeout"].is_object());
    // A CLI espera o `act` do navegador pelo prazo pedido, não pelos 60 s das outras operações.
    let src = include_str!("../bin/cli.rs");
    assert!(src.contains(r#""browser.run" if args.pointer("/request/op").and_then(Value::as_str) == Some("act")"#));
    assert!(src.contains(r#""portal.act" => Duration::from_secs(ade_ags_lib::ipc::mcp::act_timeout_secs"#));
}

/// `sim_act`/`desk_act` são o `sim.act`/`desk.act` da CLI: os mesmos argumentos e a identidade que o
/// processo herdou (nunca a que o modelo mandou), para o backend conferir com `authorize_actor`.
#[test]
fn sim_act_e_desk_act_viajam_como_o_comando_da_cli_com_a_identidade_do_processo() {
    let ctx = McpContext::Cwd { cwd: "/p".into(), tab: Some("tab-1".into()), mission: None, role: None };
    let args = super::mcp::computer_use_args(
        &ctx,
        json!({ "name": "iPhone", "goal": "abrir Ajustes", "expects": ["text:Geral"], "steps": 4.0, "timeout": 300, "from": "tab-forjada", "session": "forjado" }),
        Some("tab-1".into()),
        Some("tok".into()),
    );
    assert_eq!(args, json!({ "name": "iPhone", "goal": "abrir Ajustes", "expect": ["text:Geral"], "steps": 4, "timeout": 300, "from": "tab-1", "session": "tok" }));
    // Conversa por protocolo: sem `--tab`, a identidade é o `thread:<id>` do ambiente.
    let conversa = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None };
    let args = super::mcp::computer_use_args(&conversa, json!({ "goal": "x", "from": "outra" }), Some("thread:abc".into()), None);
    assert_eq!(args, json!({ "goal": "x", "from": "thread:abc" }));
    // Sem nada no ambiente, vale a aba do `--tab`; sem aba, nenhuma identidade (o backend recusa).
    assert_eq!(super::mcp::computer_use_args(&ctx, json!({ "goal": "x" }), None, None)["from"], "tab-1");
    assert!(super::mcp::computer_use_args(&conversa, json!({ "goal": "x" }), None, None).get("from").is_none());

    // O servidor manda o comando da CLI e devolve o status na frente.
    let (responses, sent) = mcp_session(
        &ctx,
        &[call(4, "sim_act", json!({ "name": "iPhone", "goal": "abrir Ajustes" })), call(5, "desk_act", json!({ "goal": "abrir o Mail" }))],
        |command, _| Ok(json!({ "text": format!("{command} ok"), "report": { "status": "blocked", "reason": "A pessoa não confirmou" } })),
    );
    let commands: Vec<&str> = sent.iter().map(|(c, _)| c.as_str()).collect();
    assert!(commands.contains(&"sim.act") && commands.contains(&"desk.act"), "{commands:?}");
    for r in &responses {
        let body: serde_json::Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["status"], "blocked");
    }
    // Uma tarefa da frota não tem as tools nem consegue chamá-las.
    let (responses, sent) = mcp_session(&McpContext::Task("t1".into()), &[call(6, "sim_act", json!({ "name": "iPhone", "goal": "x" }))], |_, _| Ok(json!({})));
    assert!(sent.is_empty());
    assert_eq!(responses[0]["result"]["isError"], true);
    // O simulador se aprova sozinho, como o navegador; a tela do Mac, não.
    assert!(super::mcp::auto_approved("sim_act"));
    assert!(!super::mcp::auto_approved("desk_act"));
    assert!(super::mcp::auto_approved("device_list"));
    assert!(super::mcp::auto_approved("device_shot"));
    assert!(!super::mcp::auto_approved("device_action"));
}

#[test]
fn tools_mcp_device_usam_o_despachador_agente_e_nao_pulam_o_escopo() {
    let dispatch = include_str!("commands/dispatch.rs");
    assert!(dispatch.contains("\"device.list\" => device_list(app, args)"));
    assert!(dispatch.contains("\"device.shot\" => device_action(app, args, \"shot\")"));
    assert!(dispatch.contains("\"device.act\" => super::devices::device_act(app, args)"));
    let ctx = McpContext::Cwd { cwd: "/p".into(), tab: Some("tab-1".into()), mission: None, role: None };
    let calls = [
        call(1, "device_list", json!({})),
        call(2, "device_shot", json!({ "name": "device:coredevice-id" })),
        call(3, "device_action", json!({ "name": "device:coredevice-id", "action": "tap", "x": 20, "y": 30, "from": "forjado" })),
    ];
    let (responses, sent) = mcp_session(&ctx, &calls, |command, args| Ok(json!({ "command": command, "args": args })));
    let mut commands: Vec<&str> = sent.iter().map(|(command, _)| command.as_str()).collect();
    commands.sort_unstable();
    assert_eq!(commands, ["device.act", "device.list", "device.shot"]);
    assert!(sent.iter().all(|(_, args)| args["from"] == "tab-1"));
    let device_act = sent.iter().find(|(command, _)| command == "device.act").unwrap();
    assert_eq!(device_act.1["action"], "tap");
    assert!(device_act.1.get("from").unwrap() != "forjado");
    assert!(responses.iter().all(|response| response["result"]["content"][0]["text"].is_string()));

    let (responses, sent) = mcp_session(
        &McpContext::Task("t1".into()),
        &[call(4, "device_action", json!({ "name": "iPhone", "action": "tap", "x": 1, "y": 1 }))],
        |_, _| Ok(json!({})),
    );
    assert!(sent.is_empty());
    assert_eq!(responses[0]["result"]["isError"], true);
}

/// Todo comando que uma tool de computer use manda existe no despachador.
#[test]
fn as_tools_de_computer_use_chamam_comandos_que_o_despachador_atende() {
    let dispatched = dispatched_commands();
    let table = include_str!("mcp.rs").split("const COMPUTER_USE_TOOLS").nth(1).unwrap().split("];").next().unwrap();
    let commands: Vec<&str> = table.split("dispatch: \"").skip(1).filter_map(|r| r.split('"').next()).collect();
    assert_eq!(commands, ["sim.act", "desk.act"]);
    for command in commands {
        assert!(dispatched.contains(&command.to_string()), "nadie atiende {command}");
    }
}

#[test]
fn browser_act_esta_na_lista_de_ferramentas_do_navegador_e_exige_o_objetivo() {
    assert!(super::mcp::browser_tool_names().iter().any(|name| name.ends_with("browser_act")));
    let (responses, _) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None },
        &[json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })],
        |_, _| Ok(json!({})),
    );
    let tools = responses[0]["result"]["tools"].as_array().expect("lista de tools");
    let act = tools.iter().find(|t| t["name"] == "browser_act").expect("browser_act listada");
    assert_eq!(act["inputSchema"]["required"], json!(["goal"]));
    assert!(act["inputSchema"]["properties"]["fills"]["type"] == "array");
}

/// El `--mcp-config` de cada agente lleva la ruta de `ags` sacada de al lado de la app.
/// Si no se encuentra, la tab arranca SIN navegador y sin orquestación, en silencio, y el
/// botón de instalar la CLI falla — así que tiene que encontrarse en los cinco
/// empaquetados, no solo en el que usa quien lo programó.
#[test]
fn se_encuentra_ccode_en_todos_los_empaquetados() {
    let cli = if cfg!(windows) { "ags.exe" } else { "ags" };
    let base = std::env::temp_dir().join(format!("cc-pack-{}", uuid::Uuid::new_v4()));

    // Dónde queda el binario en cada uno, y desde qué carpeta corre el ejecutable.
    let layouts: [(&str, &str, &str); 5] = [
        ("deb/rpm", "usr/bin", "usr/bin"),
        ("cargo build", "target/debug", "target/debug"),
        ("windows", "app/binaries", "app"),
        ("macos", "App.app/Contents/Resources/binaries", "App.app/Contents/MacOS"),
        ("appimage", "usr/lib/ade-ags/binaries", "usr/bin"),
    ];

    for (name, where_bin, where_exe) in layouts {
        let root = base.join(name.replace('/', "-"));
        let bin = root.join(where_bin);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join(where_exe)).unwrap();
        std::fs::write(bin.join(cli), b"#!/bin/sh\n").unwrap();

        let found = super::install::source_binary_in(&root.join(where_exe));
        let found = found.unwrap_or_else(|| panic!("no se encontró ags empaquetado como {name}"));
        assert_eq!(found.canonicalize().unwrap(), bin.join(cli).canonicalize().unwrap(), "{name}");
    }

    // Y sin binario no se inventa una ruta: es lo que hace que la app lo diga en vez de
    // escribir un `--mcp-config` que apunta a la nada.
    let vacio = base.join("vacio");
    std::fs::create_dir_all(&vacio).unwrap();
    assert!(super::install::source_binary_in(&vacio).is_none());

    std::fs::remove_dir_all(&base).ok();
}

/// Cada tab y cada tarea escribe su `--mcp-config`, y al cerrarse no lo limpian. Sin este
/// barrido `~/.ags/mcp` crece para siempre con archivos que no apunta nadie.
#[test]
fn el_barrido_borra_los_configs_de_tabs_y_tareas_que_ya_no_estan() {
    let conn = crate::database::test_db();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO windows (id, label, workspace_id, is_open, last_active) VALUES ('w1', 'main', 'ws', 1, 0);
         INSERT INTO tabs (id, window_id, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
            VALUES ('viva', 'w1', 'claude-code', 'Claude Code', 'claude', '/tmp/uno', 0, 0, 0);
         INSERT INTO runs (id, workspace_id, objective, cwd, created_at) VALUES ('r1', 'ws', 'x', '/tmp', 0);
         INSERT INTO tasks (id, run_id, title, prompt, agent_id, cwd, created_at)
            VALUES ('tarea-viva', 'r1', 't', 'p', 'claude-code', '/tmp', 0);",
    )
    .unwrap();

    let dir = std::env::temp_dir().join(format!("cc-mcp-sweep-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["tab-viva.json", "tab-cerrada.json", "tarea-viva.json", "tarea-borrada.json"] {
        std::fs::write(dir.join(name), "{}").unwrap();
    }

    assert_eq!(super::mcp::sweep_configs_in(&dir, &conn), 2);
    let mut quedaron: Vec<String> =
        std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    quedaron.sort();
    assert_eq!(quedaron, vec!["tab-viva.json", "tarea-viva.json"]);

    // Y es idempotente: correrlo de nuevo no borra lo que sí está vivo.
    assert_eq!(super::mcp::sweep_configs_in(&dir, &conn), 0);
    std::fs::remove_dir_all(&dir).ok();
}

/// La tab que lanzó el servidor viaja en cada pedido: es con lo que la app le da a ESE
/// agente su propio navegador, en vez de que todos escriban en la página del usuario.
#[test]
fn el_pedido_dice_de_que_tab_viene() {
    let (_, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: Some("tab-7".into()), mission: None, role: None },
        &[call(1, "browser_snapshot", json!({}))],
        |_, _| Ok(json!({ "text": "page: …" })),
    );
    assert_eq!(sent[0].1, json!({ "cwd": "/p", "tabId": "tab-7", "request": { "op": "snapshot" } }));
}

/// Desde una tarea, el navegador se pide por la tarea: la app sabe de qué proyecto es,
/// aunque la tarea corra en un worktree con otra carpeta.
#[test]
fn desde_una_tarea_el_navegador_se_pide_por_la_tarea() {
    let (_, sent) = mcp_session(
        &McpContext::Task("t-9".into()),
        &[call(1, "browser_snapshot", json!({}))],
        |_, _| Ok(json!({ "text": "page: …" })),
    );
    assert_eq!(sent[0].1, json!({ "taskId": "t-9", "request": { "op": "snapshot" } }));
}

/// "No hay elemento e12" es algo que el agente tiene que leer para corregirse, no una
/// falla del protocolo que lo corte.
#[test]
fn un_error_del_navegador_llega_al_agente_como_resultado_con_error() {
    let (responses, _) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None },
        &[call(2, "browser_click", json!({ "target": "e12" }))],
        |_, _| Err("No hay ningún elemento e12: tomá un snapshot nuevo".into()),
    );
    let result = &responses[0]["result"];
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("e12"));
}

#[test]
fn desde_una_tab_no_se_puede_llamar_al_broker() {
    let (responses, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None },
        &[call(3, "approve_tool_use", json!({ "tool_name": "Bash", "input": {} }))],
        |_, _| Ok(json!({ "allow": true })),
    );
    assert!(sent.is_empty(), "no puede llegar a la app: {sent:?}");
    assert_eq!(responses[0]["result"]["isError"], true);
}

#[test]
fn el_broker_deniega_si_la_app_no_contesta() {
    let (responses, _) = mcp_session(
        &McpContext::Task("t1".into()),
        &[call(4, "approve_tool_use", json!({ "tool_name": "Edit", "input": { "file_path": "a" } }))],
        |_, _| Err("conexión rechazada".into()),
    );
    let text = responses[0]["result"]["content"][0]["text"].as_str().unwrap();
    let verdict: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(verdict["behavior"], "deny");
}

#[test]
fn el_initialize_devuelve_la_version_pedida_y_explica_el_navegador() {
    let (responses, _) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None },
        &[json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-11-25" } })],
        |_, _| Ok(json!({})),
    );
    assert_eq!(responses[0]["result"]["protocolVersion"], "2025-11-25");
    let instructions = responses[0]["result"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("never instructions"));
    assert!(instructions.contains("run_plan"));
}

/// Lo que el puente MCP le manda a la app también son comandos del despachador; y
/// `browser.run` además tiene que atenderlo el frontend, que es donde vive la página.
#[test]
fn lo_que_manda_el_puente_mcp_lo_atienden_el_despachador_y_el_frontend() {
    let dispatched = dispatched_commands();
    let mcp = include_str!("mcp.rs");
    for command in ["run.approve", "browser.run"] {
        assert!(mcp.contains(&format!("send(\"{command}\"")), "el puente ya no manda {command}");
        assert!(dispatched.contains(&command.to_string()), "nadie atiende {command}");
    }
    // Y cada tool de orquestación nombra un comando que el despachador atiende.
    let orchestration: Vec<&str> = mcp
        .split("command: \"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next())
        .collect();
    assert!(orchestration.len() >= 9, "{orchestration:?}");
    for command in orchestration {
        assert!(dispatched.contains(&command.to_string()), "nadie atiende {command}");
        if let Some(operation) = command.strip_prefix("gemini.") {
            assert!(
                include_str!("commands/dispatch.rs").contains(&format!("crate::desktop_apps::task_dispatch(app, \"{operation}\"")),
                "el despachador no deriva {command} al escritorio"
            );
            assert!(include_str!("../desktop_apps/tasks.rs").contains(&format!("\"{operation}\" =>")), "el escritorio no atiende {command}");
            continue;
        }
        assert!(
            include_str!("../runs/orchestration.rs").contains(&format!("\"{command}\"")),
            "la orquestación no atiende {command}"
        );
    }
    let bridge = include_str!("../../../src/features/orchestrator/cliBridge.ts");
    assert!(bridge.contains("case \"browser.run\""), "el frontend no atiende browser.run");
}

// ── protocolo: ping, cancelar, progreso ──────────────────────────────────────────

/// Corre el servidor con un `send` propio y devuelve lo que escribió, en orden.
fn raw_session(
    context: &McpContext,
    lines: &[serde_json::Value],
    reply: impl Fn(&str, serde_json::Value) -> Result<serde_json::Value, String> + Sync,
) -> Vec<serde_json::Value> {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut output = Vec::new();
    serve(context, "", input.as_bytes(), &mut output, reply).unwrap();
    String::from_utf8(output).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn el_ping_se_contesta_con_un_resultado_vacio() {
    let cwd = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None };
    let out = raw_session(&cwd, &[json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" })], |_, _| Ok(json!({})));
    assert_eq!(out, vec![json!({ "jsonrpc": "2.0", "id": 9, "result": {} })]);
}

/// Una llamada cancelada no se contesta (lo pide la especificación) y la app recibe el
/// mismo `callId` con el que viajó la llamada, para cortar lo suyo.
#[test]
fn una_llamada_cancelada_no_se_contesta_y_la_app_se_entera() {
    let cwd = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None };
    let seen = std::sync::Mutex::new(Vec::new());
    let out = raw_session(
        &cwd,
        &[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": "run_await", "arguments": {} } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 1 } }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }),
        ],
        |command, payload| {
            seen.lock().unwrap().push((command.to_string(), payload["callId"].clone()));
            if command == "run.await" {
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
            Ok(json!({ "text": "terminó" }))
        },
    );
    // El ping se contestó mientras la llamada esperaba; la llamada, nunca.
    assert_eq!(out, vec![json!({ "jsonrpc": "2.0", "id": 2, "result": {} })]);
    let seen = seen.into_inner().unwrap();
    let call = seen.iter().find(|(c, _)| c == "run.await").expect("la llamada llegó a la app");
    let cancel = seen.iter().find(|(c, _)| c == "mcp.cancel").expect("la app se enteró de la cancelación");
    assert!(call.1.is_string());
    assert_eq!(call.1, cancel.1, "la cancelación nombra a la misma llamada");
}

/// Con `progressToken`, una llamada larga avisa que sigue viva; sin él, no se manda nada.
#[test]
fn una_llamada_larga_avisa_su_progreso_si_se_lo_piden() {
    let cwd = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None };
    let slow = |_: &str, _: serde_json::Value| {
        std::thread::sleep(std::time::Duration::from_millis(350));
        Ok(json!({ "text": "listo" }))
    };
    let call = |meta: serde_json::Value| json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "facts_read", "arguments": {}, "_meta": meta } });

    let out = raw_session(&cwd, &[call(json!({ "progressToken": "tok" }))], slow);
    let progress: Vec<_> = out.iter().filter(|m| m["method"] == "notifications/progress").collect();
    assert!(!progress.is_empty(), "{out:?}");
    assert!(progress.iter().all(|p| p["params"]["progressToken"] == "tok"));
    // El valor solo puede crecer (lo pide la especificación).
    let values: Vec<u64> = progress.iter().map(|p| p["params"]["progress"].as_u64().unwrap()).collect();
    assert!(values.windows(2).all(|w| w[0] <= w[1]));
    assert_eq!(out.last().unwrap()["id"], 3, "la respuesta llega después del progreso");

    let quiet = raw_session(&cwd, &[call(json!({}))], slow);
    assert!(quiet.iter().all(|m| m["method"] != "notifications/progress"));
}

#[test]
fn una_cancelacion_se_recuerda_por_su_id() {
    assert!(!crate::ipc::cancel::is_cancelled(Some("otra")));
    crate::ipc::cancel::cancel("c-1");
    assert!(crate::ipc::cancel::is_cancelled(Some("c-1")));
    assert!(!crate::ipc::cancel::is_cancelled(None), "un pedido de la CLI nunca está cancelado");
}

#[test]
fn el_token_se_compara_entero() {
    use super::server::token_matches;
    assert!(token_matches("abc-123", "abc-123"));
    assert!(!token_matches("abc-124", "abc-123"));
    assert!(!token_matches("abc-12", "abc-123"));
    assert!(!token_matches("", "abc-123"));
}

// ── `ags chat`: as conversas do modo chat ──────────────────────────────────────

#[test]
fn a_ajuda_e_o_front_conhecem_os_comandos_do_chat() {
    let cli = include_str!("../bin/cli.rs");
    for verbo in ["chat list", "chat new", "chat send", "chat wait", "chat show", "chat stop", "chat pending", "chat open", "chat settle"] {
        assert!(cli.contains(verbo), "a ajuda não menciona '{verbo}'");
    }
    let bridge = include_str!("../../../src/features/orchestrator/cliBridge.ts");
    assert!(bridge.contains("case \"chat.open\""), "o frontend não atende chat.open");
    // Responder à aprovação do agente da conversa é da pessoa: não há comando para isso.
    assert!(!dispatched_commands().iter().any(|c| c == "chat.answer"));
    // Cada tool `chat_*` do MCP nomeia um comando que o despachador atende.
    let dispatched = dispatched_commands();
    let chat_tools: Vec<&str> = include_str!("mcp.rs").split("ipc: \"").skip(1).filter_map(|r| r.split('"').next()).collect();
    assert_eq!(chat_tools.len(), 12, "{chat_tools:?}");
    for command in chat_tools.iter().filter(|command| command.starts_with("chat.")) {
        assert!(dispatched.contains(&command.to_string()), "nadie atiende {command}");
    }
    let mcp = include_str!("mcp.rs");
    assert!(mcp.contains("tool.ipc == \"harness.graph\""));
    assert!(mcp.contains("send(\"run.harnessGraph\""));
    assert!(dispatched.contains(&"run.harnessGraph".to_string()));
    assert!(mcp.contains("tool.ipc == \"harness.delegate\""));
    assert!(mcp.contains("name == \"delegate_task\""));
    assert!(dispatched.contains(&"run.delegateTask".to_string()));
    assert!(mcp.contains("send(\"chat.new\""));
    assert!(dispatched.contains(&"chat.new".to_string()));
}

#[test]
fn o_titulo_da_conversa_e_a_primeira_linha_curta() {
    use super::commands::conversas::title_of;
    assert_eq!(title_of("\n  arrume o login\nmais contexto"), "arrume o login");
    assert_eq!(title_of(&"x".repeat(80)).chars().count(), 61);
    assert_eq!(title_of("   "), "Conversa");
}

#[test]
fn a_ultima_resposta_e_a_ultima_fala_do_agente() {
    use super::commands::conversas::last_reply;
    use crate::canal::timeline::{Item, ItemKind};
    let item = |kind, id: &str, text: &str| Item { text: Some(text.into()), ..Item::new(kind, id.into(), None) };
    let items = [item(ItemKind::User, "u", "oi"), item(ItemKind::Assistant, "a1", "primeira"), item(ItemKind::Assistant, "a2", "segunda"), item(ItemKind::User, "u2", "e aí?")];
    assert_eq!(last_reply(&items).as_deref(), Some("segunda"));
    assert_eq!(last_reply(&items[..1]), None);
}

#[test]
fn as_tools_do_chat_aparecem_nas_abas_e_so_as_de_leitura_para_qa() {
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let names = |role: Option<&str>| -> Vec<String> {
        let ctx = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: role.map(str::to_string) };
        let (out, _) = mcp_session(&ctx, &[list.clone()], |_, _| Ok(json!({})));
        out[0]["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str().map(str::to_string)).filter(|n| n.starts_with("chat_")).collect()
    };
    let all = names(None);
    for tool in ["chat_list", "chat_new", "chat_send", "chat_wait", "chat_show", "chat_stop", "chat_pending"] {
        assert!(all.iter().any(|n| n == tool), "falta {tool}");
    }
    let qa = names(Some("QA"));
    assert!(qa.iter().any(|n| n == "chat_show"));
    assert!(!qa.iter().any(|n| n == "chat_new" || n == "chat_send" || n == "chat_stop"), "{qa:?}");
}

#[test]
fn a_conversa_nova_pelo_mcp_abre_na_pasta_de_quem_pede() {
    let ctx = McpContext::Cwd { cwd: "/meu/projeto".into(), tab: None, mission: None, role: None };
    let call = |args: serde_json::Value| json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "chat_new", "arguments": args } });
    let (_, sent) = mcp_session(&ctx, &[call(json!({ "text": "oi" }))], |_, _| Ok(json!({ "thread": { "id": "t" } })));
    assert_eq!(sent[0].0, "chat.new");
    assert_eq!(sent[0].1["cwd"], "/meu/projeto");
    let (_, sent) = mcp_session(&ctx, &[call(json!({ "text": "oi", "cwd": "/outra" }))], |_, _| Ok(json!({})));
    assert_eq!(sent[0].1["cwd"], "/outra");
}

// ── `delegate_agent`: os três destinos (Fase 4, contrato §12) ───────────────────

fn delegate_call(args: serde_json::Value) -> serde_json::Value {
    json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "delegate_agent", "arguments": args } })
}

fn delegate_ctx(tab: Option<&str>) -> McpContext {
    McpContext::Cwd { cwd: "/meu/projeto".into(), tab: tab.map(str::to_string), mission: None, role: None }
}

fn delegate_reply(command: &str, _: &serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(match command {
        "chat.new" => json!({ "thread": { "id": "filha" }, "firstMessage": "accepted" }),
        _ => json!({ "ok": true }),
    })
}

#[test]
fn delegate_agent_antigo_sem_target_envia_o_mesmo_que_o_destino_novo() {
    let ctx = delegate_ctx(Some("thread:pai"));
    let chat_old = json!({ "execution": "chat", "task": "faça", "client_request_id": "r1", "agent": "codex", "context": "trecho" });
    let chat_new = json!({ "target": "provider_chat", "task": "faça", "client_request_id": "r1", "agent": "codex", "context": "trecho" });
    let (out_old, sent_old) = mcp_session(&ctx, &[delegate_call(chat_old)], delegate_reply);
    let (out_new, sent_new) = mcp_session(&ctx, &[delegate_call(chat_new)], delegate_reply);
    assert_eq!(sent_old[0].0, "chat.new");
    assert_eq!(sent_old, sent_new, "target=provider_chat é o mesmo que execution=chat");
    assert_eq!(out_old[0]["result"], out_new[0]["result"]);
    assert_eq!(sent_old[0].1["text"], "faça");
    assert_eq!(sent_old[0].1["client_request_id"], "r1");
    assert_eq!(sent_old[0].1["parent_ref"], "thread:pai");

    let fleet_old = json!({ "execution": "fleet", "task": "faça", "client_request_id": "r2", "complexity": "hard", "isolate": false });
    let fleet_new = json!({ "target": "fleet_task", "task": "faça", "client_request_id": "r2", "complexity": "hard", "isolate": false });
    let (_, sent_old) = mcp_session(&ctx, &[delegate_call(fleet_old)], delegate_reply);
    let (_, sent_new) = mcp_session(&ctx, &[delegate_call(fleet_new)], delegate_reply);
    assert_eq!(sent_old[0].0, "run.delegateTask");
    assert_eq!(sent_old, sent_new);
    assert_eq!(sent_old[0].1["args"]["client_request_id"], "r2");
    assert_eq!(sent_old[0].1["args"]["complexity"], "hard");
}

#[test]
fn delegate_agent_recusa_destino_ausente_ou_em_conflito_sem_enviar_nada() {
    let ctx = delegate_ctx(Some("thread:pai"));
    for (args, fragment) in [
        (json!({ "task": "x", "client_request_id": "r" }), "execution precisa ser 'chat' ou 'fleet'"),
        (json!({ "execution": "agent", "task": "x", "client_request_id": "r" }), "execution precisa ser 'chat' ou 'fleet'"),
        (json!({ "target": "sessao", "task": "x", "client_request_id": "r" }), "invalid_target"),
        (json!({ "target": "fleet_task", "execution": "chat", "task": "x", "client_request_id": "r" }), "target_conflict"),
        (json!({ "target": "provider_chat", "task": "x" }), "client_request_id é obrigatório"),
    ] {
        let (out, sent) = mcp_session(&ctx, &[delegate_call(args.clone())], delegate_reply);
        assert!(sent.is_empty(), "{args}: nada pode sair");
        assert_eq!(out[0]["result"]["isError"], true, "{args}");
        let text = out[0]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(fragment), "{args}: {text}");
    }
}

#[test]
fn delegate_agent_para_sessao_conectada_vai_ao_backend_com_a_aba_real() {
    let ctx = delegate_ctx(Some("thread:pai"));
    // O modelo não escolhe o remetente: o `from` dele é descartado.
    let args = json!({
        "target": "connected_session", "to": "Codex · Backend", "task": "rode os testes", "client_request_id": "s1",
        "constraints": "sem rede", "expecting": "um diff", "policy": "ask", "when_busy": "queue", "mode": "async",
        "from": "tab:de-outro", "agent": "ignorado", "isolate": true,
    });
    let (out, sent) = mcp_session(&ctx, &[delegate_call(args)], |_, _| Ok(json!({ "delegated": true, "messageId": 7 })));
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "team.delegate");
    let payload = &sent[0].1;
    assert_eq!(payload["from"], "thread:pai");
    assert_eq!(payload["to"], "Codex · Backend");
    assert_eq!(payload["task"], "rode os testes");
    assert_eq!(payload["client_request_id"], "s1");
    assert_eq!((payload["constraints"].clone(), payload["when_busy"].clone(), payload["policy"].clone()), (json!("sem rede"), json!("queue"), json!("ask")));
    assert!(payload.get("agent").is_none() && payload.get("isolate").is_none(), "campos de outro destino não vão: {payload}");
    assert_eq!(out[0]["result"].get("isError"), None);
    assert!(out[0]["result"]["content"][0]["text"].as_str().unwrap().contains("\"messageId\":7"));
}

#[test]
fn delegate_agent_para_sessao_sem_aba_falha_antes_de_chamar_o_backend() {
    let (out, sent) = mcp_session(
        &delegate_ctx(None),
        &[delegate_call(json!({ "target": "connected_session", "to": "x", "task": "y", "client_request_id": "s1" }))],
        delegate_reply,
    );
    assert!(sent.is_empty());
    assert_eq!(out[0]["result"]["isError"], true);
}

#[test]
fn o_erro_do_backend_para_a_sessao_chega_com_o_codigo_estavel() {
    let ctx = delegate_ctx(Some("thread:pai"));
    let args = json!({ "target": "connected_session", "to": "x", "task": "y", "client_request_id": "s1" });
    let (out, _) = mcp_session(&ctx, &[delegate_call(args)], |_, _| Err("session_busy: Codex está no meio de um turno".into()));
    assert_eq!(out[0]["result"]["isError"], true);
    assert!(out[0]["result"]["content"][0]["text"].as_str().unwrap().starts_with("session_busy:"));
}

#[test]
fn o_esquema_do_delegate_agent_declara_os_tres_destinos_e_mantem_o_antigo() {
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let (out, _) = mcp_session(&delegate_ctx(Some("thread:pai")), &[list], |_, _| Ok(json!({})));
    let tool = out[0]["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "delegate_agent").unwrap().clone();
    let props = &tool["inputSchema"]["properties"];
    let targets: Vec<&str> = props["target"]["enum"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(targets, ["provider_chat", "fleet_task", "connected_session"]);
    let legacy: Vec<&str> = props["execution"]["enum"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(legacy, ["chat", "fleet"], "execution continua aceito");
    for field in ["to", "constraints", "expecting", "policy", "when_busy"] {
        assert!(props.get(field).is_some(), "falta {field}");
    }
    assert_eq!(props["policy"]["enum"], json!(["read", "ask"]), "o teto nunca passa de ask");
    let required: Vec<&str> = tool["inputSchema"]["required"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(required, ["task", "client_request_id"]);
    assert!(dispatched_commands().contains(&"team.delegate".to_string()), "ninguém atende team.delegate");
}

#[test]
fn o_envio_do_chat_pelo_mcp_carimba_o_chamador_real_e_repassa_o_id() {
    let call = |args: serde_json::Value| json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "chat_send", "arguments": args } });
    let ctx = McpContext::Cwd { cwd: "/meu/projeto".into(), tab: Some("tab-7".into()), mission: None, role: None };
    // O modelo não escolhe o escopo do recibo: o dele é descartado e vale o da sessão.
    let args = json!({ "thread": "t1", "text": "oi", "client_request_id": "r1", "caller_scope": "tab:de-outro" });
    let (_, sent) = mcp_session(&ctx, &[call(args)], |_, _| Ok(json!({ "sent": true })));
    assert_eq!(sent[0].0, "chat.send");
    assert_eq!(sent[0].1["caller_scope"], "tab:tab-7");
    assert_eq!(sent[0].1["client_request_id"], "r1");
    let bare = McpContext::Cwd { cwd: "/meu/projeto".into(), tab: None, mission: None, role: None };
    let (_, sent) = mcp_session(&bare, &[call(json!({ "thread": "t1", "text": "oi" }))], |_, _| Ok(json!({})));
    assert_eq!(sent[0].1["caller_scope"], "cwd:/meu/projeto");
    assert!(sent[0].1.get("client_request_id").is_none(), "sem o id, nada é inventado");
}

#[test]
fn a_tool_chat_send_anuncia_o_client_request_id() {
    let ctx = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None };
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let (out, _) = mcp_session(&ctx, &[list], |_, _| Ok(json!({})));
    let tools = out[0]["result"]["tools"].as_array().unwrap();
    let send = tools.iter().find(|t| t["name"] == "chat_send").expect("chat_send");
    let props = &send["inputSchema"]["properties"];
    assert_eq!(props["client_request_id"]["maxLength"], 128);
    assert!(props.get("clientRequestId").is_some());
    let required: Vec<&str> = send["inputSchema"]["required"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(required, ["thread", "text"], "o id é opcional: sem ele o envio é o de sempre");
}

#[test]
fn o_client_request_id_do_envio_e_lido_validado_e_opcional() {
    use super::commands::conversas::send_request_id;
    assert_eq!(send_request_id(&json!({ "thread": "t" })).unwrap(), None);
    assert_eq!(send_request_id(&json!({ "client_request_id": " a " })).unwrap().as_deref(), Some("a"));
    assert_eq!(send_request_id(&json!({ "clientRequestId": "b" })).unwrap().as_deref(), Some("b"));
    assert_eq!(send_request_id(&json!({ "client_request_id": "a", "clientRequestId": "a" })).unwrap().as_deref(), Some("a"));
    assert!(send_request_id(&json!({ "client_request_id": "a", "clientRequestId": "b" })).is_err());
    assert!(send_request_id(&json!({ "client_request_id": "" })).is_err());
    assert!(send_request_id(&json!({ "client_request_id": 7 })).is_err());
    assert!(send_request_id(&json!({ "client_request_id": "x".repeat(129) })).is_err());
}

#[test]
fn a_ajuda_do_chat_send_fala_do_client_request_id() {
    let cli = include_str!("../bin/cli.rs");
    let at = cli.find("chat send <id>").expect("chat send na ajuda");
    assert!(cli[at..].lines().nth(1).is_some_and(|l| l.contains("--client-request-id")), "a linha seguinte de `chat send` documenta o flag");
}

#[test]
fn a_tool_chat_stop_anuncia_o_client_request_id() {
    let ctx = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: None };
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let (out, _) = mcp_session(&ctx, &[list], |_, _| Ok(json!({})));
    let tools = out[0]["result"]["tools"].as_array().unwrap();
    let stop = tools.iter().find(|t| t["name"] == "chat_stop").expect("chat_stop");
    let props = &stop["inputSchema"]["properties"];
    assert_eq!(props["client_request_id"]["maxLength"], 128);
    assert!(props.get("clientRequestId").is_some());
    let required: Vec<&str> = stop["inputSchema"]["required"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(required, ["thread"], "o id é opcional: sem ele o Parar é o de sempre");
}

#[test]
fn o_parar_pelo_mcp_carimba_o_chamador_real_e_repassa_o_id() {
    let call = |args: serde_json::Value| json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "chat_stop", "arguments": args } });
    let ctx = McpContext::Cwd { cwd: "/meu/projeto".into(), tab: Some("tab-7".into()), mission: None, role: None };
    let args = json!({ "thread": "t1", "client_request_id": "s1", "caller_scope": "tab:de-outro" });
    let (_, sent) = mcp_session(&ctx, &[call(args)], |_, _| Ok(json!({ "stopped": true })));
    assert_eq!(sent[0].0, "chat.stop");
    assert_eq!(sent[0].1["caller_scope"], "tab:tab-7", "o escopo vem da sessão, não do modelo");
    assert_eq!(sent[0].1["client_request_id"], "s1");
}

#[test]
fn a_ajuda_do_chat_stop_fala_do_client_request_id() {
    let cli = include_str!("../bin/cli.rs");
    let at = cli.find("chat stop <id>").expect("chat stop na ajuda");
    assert!(cli[at..].lines().nth(1).is_some_and(|l| l.contains("--client-request-id")), "a linha seguinte de `chat stop` documenta o flag");
}

#[test]
fn o_comando_tauri_do_parar_recebe_o_client_request_id() {
    let commands = include_str!("../conversa/commands.rs");
    let at = commands.find("fn chat_thread_interrupt").expect("o comando Tauri do Parar");
    let signature = commands[at..].lines().next().unwrap_or_default();
    assert!(signature.contains("client_request_id: Option<String>"), "o Parar do Tauri não recebe o id: {signature}");
}

#[test]
fn as_tools_do_chat_dizem_se_leem_ou_escrevem() {
    assert_eq!(super::mcp::annotations("chat_show")["readOnlyHint"], true);
    assert_eq!(super::mcp::annotations("chat_wait")["readOnlyHint"], true);
    assert_eq!(super::mcp::annotations("chat_new")["readOnlyHint"], false);
    assert_eq!(super::mcp::annotations("chat_new")["destructiveHint"], false);
}

// ── `ags design`: a tela de Design ────────────────────────────────────────────

/// As tools `design_*` do MCP, lidas da tabela (`cli: "design.x"`).
fn design_tools() -> Vec<(String, String)> {
    include_str!("mcp.rs")
        .split("DesignTool { name: \"")
        .skip(1)
        .filter_map(|r| {
            let name = r.split('"').next()?;
            let cli = r.split("cli: \"").nth(1)?.split('"').next()?;
            Some((name.to_string(), cli.to_string()))
        })
        .collect()
}

#[test]
fn a_ajuda_o_despachador_e_o_mcp_conhecem_os_comandos_de_design() {
    let cli = include_str!("../bin/cli.rs");
    for verbo in ["design view", "design open", "design artboard duplicate", "design artboard delete", "design artboard resize", "design page rename", "page delete", "design note add"] {
        assert!(cli.contains(verbo), "a ajuda não menciona '{verbo}'");
    }
    let dispatched = dispatched_commands();
    let tools = design_tools();
    assert_eq!(tools.len(), 15, "{tools:?}");
    for (name, command) in &tools {
        assert_eq!(&name.replace('_', "."), command, "o nome da tool não casa com o comando");
        assert!(dispatched.contains(command), "nadie atiende {command}");
    }
    // Abrir a tela é pedido ao front pela ponte, como o `chat.open`.
    assert!(include_str!("commands/dispatch.rs").contains("bridge_call(app, \"design.open\""));
    assert!(include_str!("../../../src/features/orchestrator/cliBridge.ts").contains("case \"design.open\""), "o front não atende design.open");
    // Aprovar e rejeitar são da pessoa: não há tool para isso.
    assert!(!tools.iter().any(|(n, _)| n.contains("approve") || n.contains("reject")));
}

#[test]
fn as_tools_de_design_aparecem_nas_abas_e_so_as_de_leitura_para_qa() {
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let names = |role: Option<&str>| -> Vec<String> {
        let ctx = McpContext::Cwd { cwd: "/p".into(), tab: None, mission: None, role: role.map(str::to_string) };
        let (out, _) = mcp_session(&ctx, &[list.clone()], |_, _| Ok(json!({})));
        tool_names(&out[0]).into_iter().filter(|n| n.starts_with("design_")).collect()
    };
    assert_eq!(names(None).len(), 15);
    let qa = names(Some("QA"));
    assert_eq!(qa, vec!["design_list", "design_get", "design_view"]);
    assert_eq!(super::mcp::annotations("design_view")["readOnlyHint"], true);
    assert_eq!(super::mcp::annotations("design_artboard_delete")["readOnlyHint"], false);
}

#[test]
fn o_design_pelo_mcp_nasce_na_pasta_da_aba_e_o_comentario_e_do_agente() {
    let ctx = McpContext::Cwd { cwd: "/meu/projeto".into(), tab: Some("aba-1".into()), mission: Some("m1".into()), role: None };
    let (_, sent) = mcp_session(&ctx, &[call(2, "design_create", json!({ "title": "Onboarding", "from": "outra" }))], |_, _| Ok(json!({ "id": "d1" })));
    assert_eq!(sent[0].0, "design.create");
    assert_eq!((sent[0].1["workspace"].clone(), sent[0].1["missionId"].clone(), sent[0].1["from"].clone()), (json!("/meu/projeto"), json!("m1"), json!("aba-1")));
    let (_, sent) = mcp_session(&ctx, &[call(2, "design_comment_add", json!({ "artboardId": "b1", "text": "feito", "author": "user" }))], |_, _| Ok(json!({})));
    assert_eq!((sent[0].0.as_str(), sent[0].1["author"].clone()), ("design.comment.add", json!("agent")));
    let (out, sent) = mcp_session(&ctx, &[call(2, "design_view", json!({}))], |_, _| Ok(json!({ "open": false })));
    assert_eq!(sent[0].0, "design.view");
    assert!(out[0]["result"]["content"][0]["text"].as_str().unwrap().contains("\"open\":false"));
}

#[test]
fn sim_act_tem_rota_backend_e_scope_do_device_sem_fallback_para_udid_solto() {
    let dispatch=include_str!("commands/dispatch.rs");
    let handler=include_str!("commands/sim_act.rs");
    let devices=include_str!("commands/devices.rs");
    assert!(dispatch.contains("\"sim.act\" => super::sim_act::act(app, args)"));
    assert!(handler.contains("super::devices::ios_target"));
    assert!(devices.contains("pub(super) fn ios_target"));
    assert!(handler.contains("crate::terminal::authorize_actor"));
    assert!(handler.contains("crate::ipc::current_client_pid"));
}

#[test]
fn desk_act_usa_a_mesma_identidade_do_sim_act_e_nao_aceita_o_from_sem_verificar() {
    let dispatch = include_str!("commands/dispatch.rs");
    let handler = include_str!("commands/desk_act.rs");
    assert!(dispatch.contains("\"desk.act\" => super::desk_act::act(app, args)"));
    assert!(handler.contains("crate::terminal::authorize_actor"));
    assert!(handler.contains("crate::ipc::current_client_pid"));
    // A identidade é conferida antes de qualquer captura.
    assert!(handler.find("authorize_actor").unwrap() < handler.find("desktop::act").unwrap());
}

#[test]
fn publicacao_inicial_preserva_dono_vivo_e_assume_apos_sua_saida() {
    let dir = std::env::temp_dir().join(format!("ade-global-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let global = dir.join("ipc.json");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let old = super::protocol::Handshake {
        pid: 123, port: listener.local_addr().unwrap().port(), protocol: 1,
        token: "antigo".into(), socket: None,
    };
    let new = super::protocol::Handshake { pid: 456, token: "novo".into(), ..old.clone() };
    let original = serde_json::to_string(&old).unwrap();
    std::fs::write(&global, &original).unwrap();
    super::server::publish_global(&global, &new).unwrap();
    assert_eq!(std::fs::read_to_string(&global).unwrap(), original, "segunda instância não toma o global");
    drop(listener);
    super::server::publish_global(&global, &new).unwrap();
    let current: super::protocol::Handshake = serde_json::from_str(&std::fs::read_to_string(&global).unwrap()).unwrap();
    assert_eq!(current.pid, new.pid, "restart assume o global quando o dono antigo morre");
    std::fs::remove_dir_all(dir).unwrap();
}

// ── Contratos do deepseek-harness (pontos 3, 5, 7, 14, 19 e 22) ──────────

/// Uma tool que devolve texto enorme chega ao agente como cabeça, cauda e o caminho do spill; a
/// decisão de permissão (`approve_tool_use`) nunca passa pelo spill.
#[test]
fn resposta_grande_de_tool_vira_spill_e_a_permissao_nao() {
    let big: String = (0..4000).map(|i| format!("linha {i}\n")).collect();
    let tab = McpContext::Cwd { cwd: "/p".into(), tab: Some("tab-9".into()), mission: None, role: None };
    let reply = big.clone();
    let out = raw_session(&tab, &[call(1, "run_await", json!({}))], move |_, _| Ok(json!({ "text": reply.clone() })));
    let text = out[0]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.len() < big.len() && text.contains("bytes omitidos") && text.contains("tab-9"), "{}", &text[..200.min(text.len())]);
    let path = text.split(" O texto inteiro está em ").nth(1).and_then(|r| r.split(" — ").next()).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), big);

    let task = McpContext::Task("t-1".into());
    let decision = serde_json::to_string(&json!({ "behavior": "deny", "message": big })).unwrap();
    let out = raw_session(&task, &[call(2, "approve_tool_use", json!({ "tool_name": "Bash", "input": {} }))], move |_, _| Ok(json!({ "text": decision.clone() })));
    assert!(!out[0]["result"]["content"][0]["text"].as_str().unwrap().contains("bytes omitidos"));
}

/// `ask_user` documenta o prazo: `pending` nunca é aprovação, e o integrante leva a dúvida ao lead.
#[test]
fn ask_user_diz_que_o_prazo_vira_pending_e_nao_aprovacao() {
    let tab = McpContext::Cwd { cwd: "/p".into(), tab: Some("tab-1".into()), mission: None, role: None };
    let out = raw_session(&tab, &[json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })], |_, _| Ok(json!({})));
    let tools = out[0]["result"]["tools"].as_array().unwrap();
    let ask = tools.iter().find(|t| t["name"] == super::mcp::ASK_TOOL).unwrap();
    let description = ask["description"].as_str().unwrap();
    assert!(description.contains("`status: \"pending\"`") && description.contains("NOT an answer nor an approval"), "{description}");
    assert!(description.contains("ask_lead"));
    assert!(ask["inputSchema"]["properties"]["timeout_s"]["description"].as_str().unwrap().contains("Default 600"));
    // O `pending` que a app devolve chega ao agente como texto, não como erro nem aprovação.
    let out = raw_session(&tab, &[call(2, "ask_user", json!({ "question": "Qual conta?" }))], |_, _| {
        Ok(json!({ "status": "pending", "text": "PENDENTE: a pessoa não respondeu" }))
    });
    assert!(out[0]["result"].get("isError").is_none());
    assert!(out[0]["result"]["content"][0]["text"].as_str().unwrap().starts_with("PENDENTE"));
}

/// A CLI manda quem chama (`from`) no `events.*`, para o `wait` saber se é um orquestrador; e a
/// ajuda documenta `--allow-idle`, a recusa do recruit, o v1.1 do deliver e o spill.
#[test]
fn a_cli_documenta_e_identifica_os_contratos_novos() {
    let cli = include_str!("../bin/cli.rs");
    let groups = cli.split("const GROUPS").nth(1).and_then(|r| r.split("];").next()).unwrap();
    assert!(groups.contains("\"events.\""), "events.* precisa do `from`");
    for needle in ["--allow-idle", "noProgress", "depth|active_cap", "v1.1", "--no-spill", "MCP_TOOLS_HELP", "BEGIN GENERATED: mcp-tools-help"] {
        assert!(cli.contains(needle), "a ajuda não menciona {needle}");
    }
    assert!(include_str!("commands/dispatch.rs").contains("\"events.wait\" => events_wait(app, args)"));
    let skill = include_str!("../../../skills/ags-orchestrator/SKILL.md");
    for needle in ["noProgress", "active_cap", "`blocked` needs", "status: \"pending\"", "~/.ags/spill/", "BEGIN GENERATED: cli-commands", "BEGIN GENERATED: mcp-tools"] {
        assert!(skill.contains(needle), "a skill não menciona {needle}");
    }
}

#[test]
fn device_rotate_tem_rota_acao_e_o_mesmo_giro_do_canvas() {
    let dispatch = include_str!("commands/dispatch.rs");
    let devices = include_str!("commands/devices.rs");
    let ios = include_str!("commands/simulators.rs");
    assert!(dispatch.contains("\"device.rotate\" => device_action(app, args, \"rotate\")"));
    assert!(devices.contains("\"rotate\", ") || devices.contains("\"rotate\"]"));
    // O agente gira pelo mesmo caminho da barra e do painel: endireita as telas e avisa o frontend.
    assert!(ios.contains("crate::simulator::rotate_device(app, &udid, &dir)"));
    assert!(include_str!("../simulator/commands.rs").contains("app.emit(\"simulator-orientation\""));
}

#[test]
fn device_clipboard_le_e_escreve_pelo_devicectl() {
    let dispatch = include_str!("commands/dispatch.rs");
    let ios = include_str!("commands/simulators.rs");
    let ops = include_str!("../simulator/mod.rs");
    assert!(dispatch.contains("\"device.clipboard\" => device_action(app, args, \"clipboard\")"));
    assert!(ios.contains("ops::set_clipboard_text(&udid, &text)") && ios.contains("ops::clipboard_text(&udid)"));
    // O caminho público do Xcode 27 (CoreDevice), não o SimPasteboard, que no iOS 27.2 já não substitui o conteúdo.
    assert!(ops.contains("[\"devicectl\", \"device\", \"pasteboard\"]"));
}

#[test]
fn o_terminal_do_chat_tem_quem_o_atenda_nos_dois_lados() {
    // O backend pede ao front o shell do painel (`chatShell`), e o front o abre pelo mesmo caminho da aba Terminal.
    let tabs = include_str!("commands/tabs.rs");
    assert!(tabs.contains("\"chatShell\": true"), "o backend não pede o terminal do chat");
    let bridge = include_str!("../../../src/features/orchestrator/cliBridge.ts");
    assert!(bridge.contains("args.chatShell === true"), "o frontend não atende o terminal do chat");
    assert!(bridge.contains("openChatTerminal("), "o frontend não usa o shell do painel");
    // A CLI documenta as flags novas e leva quem chama no `tab create`.
    let cli = include_str!("../bin/cli.rs");
    assert!(cli.contains("--in-chat") && cli.contains("--new-tab"), "o USAGE não mostra --in-chat/--new-tab");
    assert!(cli.contains("command == \"tab.create\""), "a CLI não manda quem chama no tab create");
    // A skill ensina o caminho, e o que fazer quando ele falha.
    let skill = include_str!("../../../skills/ags-orchestrator/SKILL.md");
    assert!(skill.contains("### Interactive commands from a chat conversation"), "a skill não ensina o terminal do chat");
    assert!(skill.contains("--in-chat"), "a skill não mostra --in-chat");
}

// ── Guardas da superfície de rede do IPC (ver docs/decisoes/HOST_REMOTO.md) ──
//
// Estes testes leem o código, como os de contrato acima: não provam o comportamento de rede,
// provam que as frases que dão essa garantia continuam no código. Trocar o bind por
// `0.0.0.0`, tirar a checagem do token ou o teto de conexões faz um deles falhar.

/// Os arquivos de topo de `src/ipc` (sem o `test.rs`), lidos do disco. Um arquivo novo entra sozinho.
fn fontes_de_producao_do_ipc() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ipc");
    let mut fontes: Vec<(String, String)> = std::fs::read_dir(&dir)
        .expect("src/ipc tem que existir")
        .flatten()
        .map(|entrada| entrada.path())
        .filter(|caminho| caminho.extension().and_then(|ext| ext.to_str()) == Some("rs"))
        .filter(|caminho| caminho.file_name().and_then(|nome| nome.to_str()) != Some("test.rs"))
        .map(|caminho| {
            let nome = caminho.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            (nome, std::fs::read_to_string(&caminho).expect("arquivo do ipc legível"))
        })
        .collect();
    fontes.sort();
    fontes
}

#[test]
fn o_ipc_so_escuta_em_loopback() {
    // Um único listener TCP, em 127.0.0.1 com porta efêmera. Qualquer outro endereço abriria o IPC à rede local.
    let server = include_str!("server.rs");
    assert_eq!(server.matches("TcpListener::bind(").count(), 1, "o IPC tem que ter um único bind TCP");
    assert!(server.contains("TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))"), "o bind do IPC saiu de 127.0.0.1 com porta 0");
    for (nome, fonte) in fontes_de_producao_do_ipc() {
        for proibido in ["0.0.0.0", "UNSPECIFIED", "[::]", "UdpSocket::bind("] {
            assert!(!fonte.contains(proibido), "{nome} usa {proibido}: o IPC não pode escutar fora do loopback");
        }
        if nome != "server.rs" {
            assert!(!fonte.contains("TcpListener::bind("), "{nome} abre um listener TCP fora do servidor do IPC");
        }
    }
    // O cliente também só fala com o loopback: a porta vem do handshake, o endereço é fixo.
    let transport = include_str!("transport.rs");
    assert!(transport.contains("SocketAddrV4::new(Ipv4Addr::LOCALHOST, handshake.port)"), "a CLI deixou de conectar só em 127.0.0.1");
}

#[test]
fn o_pedido_sem_token_valido_e_recusado_antes_do_despacho() {
    let server = include_str!("server.rs");
    let checagem = server.find("token_matches(&req.token, expected_token)").expect("o servidor deixou de comparar o token");
    let despacho = server.find("commands::dispatch(app, &req.command, &req.args)").expect("o despacho mudou de forma");
    assert!(checagem < despacho, "um comando roda antes da checagem do token");
    assert!(server.contains("Token inválido"), "o pedido sem token válido não recebe a recusa");
    // Um token novo a cada início, do gerador aleatório do uuid (não do PID nem do relógio).
    assert!(server.contains("let token = Uuid::new_v4().to_string();"), "o token deixou de ser um UUID v4 por processo");
}

#[test]
fn um_token_de_outra_instancia_nao_vale_aqui() {
    use super::server::token_matches;
    let este = uuid::Uuid::new_v4().to_string();
    let outro = uuid::Uuid::new_v4().to_string();
    assert!(token_matches(&este, &este));
    assert!(!token_matches(&outro, &este), "o token de outra instância foi aceito");
    assert!(!token_matches(&format!("{este}x"), &este), "a comparação do token deixou de ser exata");
}

#[test]
fn uma_linha_http_nao_vira_pedido_do_ipc() {
    // O IPC não confere `Host` nem `Origin` (HOST_REMOTO.md, F-06). O que mantém uma página do navegador
    // de fora é o formato: a primeira linha de um pedido HTTP não é JSON e o servidor recusa antes de
    // qualquer comando. Se este listener um dia aceitar HTTP, a checagem de `util::loopback_trust` tem
    // que entrar junto com a rota.
    for linha in ["GET / HTTP/1.1", "POST /ipc HTTP/1.1", "OPTIONS / HTTP/1.1", "Host: 127.0.0.1:1"] {
        assert!(serde_json::from_str::<Request>(linha).is_err(), "{linha:?} virou pedido do IPC");
    }
    let server = include_str!("server.rs");
    let leitura = server.find("serde_json::from_str::<Request>(&line)").expect("o parse do pedido mudou de forma");
    let checagem = server.find("token_matches(&req.token, expected_token)").expect("o servidor deixou de comparar o token");
    assert!(leitura < checagem, "o token é conferido antes de o pedido ser lido");
}

#[test]
fn os_limites_do_canal_ficam_no_codigo() {
    // Sem estes limites, um cliente local sem token segura uma vaga e um buffer sem tamanho nem prazo (HOST_REMOTO.md, F-03).
    let intake = include_str!("intake.rs");
    assert!(intake.contains("const MAX_CONNECTIONS: usize = 256;"), "o teto de conexões sumiu");
    assert!(intake.contains("const MAX_UNAUTHENTICATED: usize = 32;"), "o teto de conexões sem token sumiu");
    assert!(intake.contains("const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;"), "o teto de tamanho do pedido sumiu");
    assert!(intake.contains("const TOKEN_WINDOW: usize = 1024;"), "a janela do token sumiu");
    assert!(intake.contains("const TOKEN_DEADLINE_MS: u64 = 5_000;") && intake.contains("const REQUEST_DEADLINE_MS: u64 = 30_000;"), "os prazos totais sumiram");
    let server = include_str!("server.rs");
    assert!(server.contains("intake::READ_TIMEOUT_SECS"), "a conexão TCP não tem prazo de leitura");
    assert!(server.contains("try_acquire()"), "o TCP deixou de respeitar o teto");
    let transport = include_str!("transport.rs");
    assert!(transport.contains("try_acquire()"), "o canal de credencial deixou de respeitar o teto");
    assert!(transport.contains("intake::READ_TIMEOUT_SECS"), "o canal de credencial não tem prazo de leitura");
}

#[test]
fn o_handshake_e_o_socket_de_credencial_continuam_so_do_usuario() {
    // Quem lê o token lê todo o IPC: o arquivo que o guarda e o socket de credencial ficam em 0600.
    let server = include_str!("server.rs");
    assert!(server.contains("options.mode(0o600)"), "o handshake deixou de ser 0600");
    let transport = include_str!("transport.rs");
    assert!(transport.contains("std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))"), "o socket de credencial deixou de ser 0600");
    // Named pipe do Windows: sem essa flag, um cliente remoto pela rede (SMB) alcança o pipe.
    assert!(transport.contains("PIPE_REJECT_REMOTE_CLIENTS"), "o named pipe aceita clientes remotos");
}

// ── F-02, F-09, peer.answer e fix.decide: prova do que o servidor consegue verificar ──────────

mod provas {
    use super::json;
    use crate::canvas::{Board, Boards};
    use crate::terminal::Caller;

    /// Um quadro com conexões `(a, b)`, orquestradores e nós. `chave` decide se é de missão (`#m:`).
    fn quadro(chave: &str, arestas: &[(&str, &str)], orquestradores: &[&str], nos: &[&str]) -> Boards {
        let edges: Vec<_> = arestas.iter().enumerate().map(|(i, (a, b))| json!({ "id": format!("e{i}"), "a": a, "b": b })).collect();
        let nodes: serde_json::Map<String, serde_json::Value> = nos.iter().map(|n| (n.to_string(), json!({}))).collect();
        let board: Board = serde_json::from_value(json!({ "edges": edges, "orchestrators": orquestradores, "nodes": nodes })).unwrap();
        Boards::from([(chave.to_string(), board)])
    }

    fn aba(id: &str) -> Caller {
        Caller::Tab(id.to_string())
    }

    // F-02

    #[test]
    fn um_task_id_sem_o_processo_da_tarefa_e_recusado_e_sem_task_id_nada_muda() {
        // Nada declarado: nada a provar.
        assert!(super::super::guard::task_proof_error(&json!({ "cwd": "/x" }), None).is_none());
        assert!(super::super::guard::task_proof_error(&json!({ "taskId": "" }), None).is_none());
        if !crate::terminal::ancestry_required() {
            return;
        }
        // Declarada, mas sem processo registrado para ela (id inventado) e sem PID (TCP): recusa.
        let recusa = super::super::guard::task_proof_error(&json!({ "taskId": "tarefa-inventada" }), Some(1)).unwrap();
        assert!(recusa.contains("tarefa"), "{recusa}");
        assert!(super::super::guard::task_proof_error(&json!({ "taskId": "tarefa-inventada" }), None).is_some());
    }

    #[test]
    fn o_despachador_prova_o_task_id_antes_de_olhar_a_politica_da_tarefa_ou_o_banco() {
        let dispatch = include_str!("commands/dispatch.rs");
        let prova = dispatch.find("crate::ipc::guard::task_proof_error(args").expect("o despachador não prova o taskId");
        let politica = dispatch.find("guard_task(&conn, args.get(\"taskId\")").expect("a política da tarefa mudou de forma");
        let banco = dispatch.find("try_state::<crate::database::DbConnection>()").expect("o banco mudou de forma");
        assert!(prova < politica && prova < banco, "o taskId é usado antes de ser provado");
        // `run.approve` também: a exceção dele era só da política (o broker cria a espera).
        assert!(!dispatch[prova - 60..prova].contains("command !="), "a prova do taskId ficou condicionada ao comando (run.approve fora?)");
    }

    #[test]
    fn o_supervisor_registra_o_processo_da_tarefa_e_o_libera_ao_sair() {
        let supervisor = include_str!("../runs/supervisor.rs");
        assert!(supervisor.contains("register_task_process(&task.id"), "o supervisor não registra o PID do agente");
        assert!(supervisor.contains("release_task_process(&task_id)"), "o PID da tarefa nunca é liberado");
        // Registrado antes de a tarefa virar `running`: o MCP do agente já pode estar chamando.
        assert!(supervisor.find("register_task_process(&task.id").unwrap() < supervisor.find("store::mark_running(").unwrap());
    }

    // F-09: tab.send

    #[test]
    fn a_pessoa_no_proprio_terminal_continua_escrevendo_em_qualquer_aba() {
        let quadros = Boards::new();
        assert!(super::super::guard::tab_send_error(&quadros, &Caller::Outside, "qualquer", None).is_none());
    }

    #[test]
    fn um_agente_do_ade_nao_escreve_em_aba_fora_do_alcance_dele() {
        let quadros = quadro("/repo", &[("lead", "membro")], &["lead"], &["lead", "membro"]);
        let recusa = super::super::guard::tab_send_error(&quadros, &aba("membro"), "aba-da-pessoa", None).unwrap();
        assert!(recusa.contains("aba-da-pessoa"), "{recusa}");
        // Nem a que está num quadro sem ligação com ele.
        let outro = quadro("/outro", &[("x", "y")], &[], &["x", "y"]);
        assert!(super::super::guard::tab_send_error(&outro, &aba("membro"), "y", None).is_some());
    }

    #[test]
    fn um_agente_escreve_em_si_nos_vizinhos_no_time_e_nas_abas_que_ele_abriu() {
        let quadros = quadro("/repo", &[("lead", "m1"), ("lead", "m2")], &["lead"], &["lead", "m1", "m2"]);
        let ok = |de: &str, para: &str, abriu: Option<&str>| super::super::guard::tab_send_error(&quadros, &aba(de), para, abriu).is_none();
        assert!(ok("m1", "m1", None), "a si mesma");
        assert!(ok("m1", "lead", None), "o vizinho direto");
        assert!(ok("m1", "m2", None), "o outro integrante da estrela");
        assert!(ok("lead", "m2", None), "o orquestrador alcança o time");
        assert!(ok("solo", "terminal-que-abri", Some("solo")), "a aba que o próprio agente abriu");
        assert!(!ok("solo", "terminal-de-outro", Some("outro")), "a aba aberta por outro agente");
    }

    #[test]
    fn quem_abriu_a_aba_fica_registrado_so_com_prova() {
        let (quem, aba_id) = (format!("abridor-{}", uuid::Uuid::new_v4()), format!("aba-{}", uuid::Uuid::new_v4()));
        assert_eq!(super::super::guard::opened_by(&aba_id), None);
        super::super::guard::record_opened_tab(&quem, &aba_id);
        assert_eq!(super::super::guard::opened_by(&aba_id).as_deref(), Some(quem.as_str()));
    }

    #[test]
    fn o_tab_send_prova_quem_chama_antes_de_tocar_o_terminal() {
        let tabs = include_str!("commands/tabs.rs");
        let inicio = tabs.find("pub(super) fn tab_send(").expect("tab_send mudou de forma");
        let corpo = &tabs[inicio..];
        let prova = corpo.find("crate::terminal::classify_caller").expect("tab_send não prova quem chama");
        let escreve = corpo.find("pty_id_for_tab(").expect("tab_send mudou de forma");
        let regra = corpo.find("tab_send_error(").expect("tab_send não aplica o escopo");
        assert!(prova < escreve && regra < escreve, "tab_send escreve antes de provar quem chama e o escopo");
        // A aba que o agente abre passa a ser lembrada (só com identidade provada).
        assert!(tabs.contains("record_opened_tab("), "tab_create não registra quem abriu a aba");
        // O token de sessão nunca atravessa a ponte para a interface.
        assert!(tabs.contains("forwarded.as_object_mut()") || tabs.contains("remove(\"session\")"), "o ADE_SESSION vai para a ponte do front");
    }

    // peer.answer

    #[test]
    fn peer_answer_responde_como_a_aba_provada_e_nunca_como_a_declarada() {
        let canal = include_str!("commands/canal.rs");
        let inicio = canal.find("pub(super) fn peer_answer(").expect("peer_answer mudou de forma");
        let corpo = &canal[inicio..];
        let prova = corpo.find("crate::terminal::authorize_actor").expect("peer_answer não prova quem chama");
        let efeito = corpo.find("write_to_pty").expect("peer_answer mudou de forma");
        assert!(prova < corpo.find("let item =").unwrap() && prova < efeito, "peer_answer age antes de provar quem chama");
        assert!(!corpo[..efeito].contains("let from = caller(args)?"), "peer_answer ainda confia no `from` declarado");
    }

    // fix.decide

    #[test]
    fn so_o_orquestrador_da_missao_decide_a_correcao_e_a_pessoa_pela_tela() {
        let quadros = quadro("/repo#m:m1", &[("lead", "dev")], &["lead"], &["lead", "dev"]);
        let escopo = crate::runs::fixrounds::scope_mission("m1");
        let erro = |c: Caller, esc: &str| super::super::guard::fix_decide_error(&quadros, &c, esc);
        assert!(erro(aba("lead"), &escopo).is_none(), "o orquestrador da missão decide");
        assert!(erro(aba("dev"), &escopo).unwrap().contains("orquestrador"), "um integrante não decide");
        assert!(erro(Caller::Outside, &escopo).unwrap().contains("tela"), "sem prova de papel, só pela tela");
        // Orquestrador de outra missão, ou escopo da Frota (`run:`): pela tela.
        let outra = quadro("/repo#m:m2", &[], &["lead"], &["lead"]);
        assert!(super::super::guard::fix_decide_error(&outra, &aba("lead"), &escopo).is_some());
        assert!(erro(aba("lead"), &crate::runs::fixrounds::scope_run("r1")).unwrap().contains("tela"));
    }

    #[test]
    fn o_fix_decide_do_ipc_aplica_a_regra_antes_de_decidir() {
        let fix = include_str!("../runs/fixrounds.rs");
        let inicio = fix.find("pub fn cli(").expect("fixrounds::cli mudou de forma");
        let corpo = &fix[inicio..];
        let regra = corpo.find("fix_decide_error(").expect("fix.decide não aplica a regra do papel");
        let decide = corpo.find("decide(&conn, scope").expect("fix.decide mudou de forma");
        assert!(regra < decide, "fix.decide decide antes de checar o papel");
        assert!(corpo.contains("crate::terminal::classify_caller"), "fix.decide não prova quem chama");
    }

    // A CLI manda a sessão (e só a do ambiente) para quem precisa de prova.

    #[test]
    fn a_cli_manda_a_sessao_do_ambiente_nos_comandos_que_exigem_prova() {
        let cli = include_str!("../bin/cli.rs");
        for comando in ["peer.answer", "tab.send", "tab.create", "fix.decide"] {
            assert!(cli.contains(&format!("\"{comando}\"")), "{comando} não está entre os que mandam a sessão");
        }
        assert!(cli.contains("const GROUPS: [&str; 20]") && cli.contains("\"fix.\""), "o grupo fix. não leva quem chama");
    }
}

// ── F-03: limites antes da autenticação ──────────────────────────────────────────────────────

mod entrada {
    use super::super::intake::{read_request, Intake, Slots, MAX_REQUEST_BYTES, TOKEN_DEADLINE_MS, REQUEST_DEADLINE_MS, TOKEN_WINDOW};
    use std::cell::Cell;
    use std::io::{BufReader, Read};
    use std::rc::Rc;

    const TOKEN: &str = "0e6f2c1a-3c2b-4e7d-9a53-1f0d5b8c7a21";

    /// Um cliente lento: entrega `chunk` bytes por leitura e cada leitura gasta `tick_ms` do relógio de mentira.
    struct Gotejando {
        dados: Vec<u8>,
        pos: usize,
        chunk: usize,
        tick_ms: u64,
        relogio: Rc<Cell<u64>>,
        lidos: Rc<Cell<usize>>,
    }

    impl Read for Gotejando {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.relogio.set(self.relogio.get() + self.tick_ms);
            let n = self.chunk.min(buf.len()).min(self.dados.len() - self.pos);
            buf[..n].copy_from_slice(&self.dados[self.pos..self.pos + n]);
            self.pos += n;
            self.lidos.set(self.lidos.get() + n);
            Ok(n)
        }
    }

    struct Cena {
        relogio: Rc<Cell<u64>>,
        lidos: Rc<Cell<usize>>,
        autenticou: Cell<u32>,
    }

    fn ler(dados: Vec<u8>, chunk: usize, tick_ms: u64) -> (Intake, Cena) {
        let cena = Cena { relogio: Rc::new(Cell::new(0)), lidos: Rc::new(Cell::new(0)), autenticou: Cell::new(0) };
        let origem = Gotejando { dados, pos: 0, chunk, tick_ms, relogio: cena.relogio.clone(), lidos: cena.lidos.clone() };
        let mut leitor = BufReader::with_capacity(chunk.max(16), origem);
        let relogio = cena.relogio.clone();
        let mut agora = move || relogio.get();
        let mut marca = || cena.autenticou.set(cena.autenticou.get() + 1);
        let resultado = read_request(&mut leitor, TOKEN, &mut agora, &mut marca);
        (resultado, cena)
    }

    fn pedido(token: &str, args: &str) -> Vec<u8> {
        format!("{{\"token\":\"{token}\",\"command\":\"tab.list\",\"args\":{args}}}\n").into_bytes()
    }

    #[test]
    fn token_errado_e_recusado_depois_de_ler_so_o_comeco_do_pedido() {
        let mut dados = format!("{{\"token\":\"errado\",\"command\":\"x\",\"args\":\"").into_bytes();
        dados.extend(std::iter::repeat_n(b'a', 4 * 1024 * 1024));
        let (resultado, cena) = ler(dados, 256, 0);
        assert!(matches!(&resultado, Intake::Refused(m) if m.contains("Token inválido")), "{resultado:?}");
        assert!(cena.lidos.get() <= 2 * TOKEN_WINDOW, "leu {} bytes de um cliente sem token válido", cena.lidos.get());
        assert_eq!(cena.autenticou.get(), 0, "a vaga sem autenticação foi liberada sem token");
    }

    #[test]
    fn token_fora_dos_primeiros_bytes_nao_vale() {
        let enchimento = "a".repeat(TOKEN_WINDOW + 200);
        let dados = format!("{{\"command\":\"x\",\"args\":\"{enchimento}\",\"token\":\"{TOKEN}\"}}\n").into_bytes();
        let (resultado, cena) = ler(dados, 512, 0);
        assert!(matches!(resultado, Intake::Refused(_)), "{resultado:?}");
        assert!(cena.lidos.get() <= 2 * TOKEN_WINDOW);
    }

    #[test]
    fn com_o_token_certo_o_pedido_e_lido_inteiro_ate_o_teto() {
        let grande = format!("{{\"x\":\"{}\"}}", "b".repeat(300_000));
        let dados = pedido(TOKEN, &grande);
        let esperado = String::from_utf8(dados.clone()).unwrap();
        let (resultado, cena) = ler(dados, 4096, 0);
        assert_eq!(resultado, Intake::Line(esperado));
        assert_eq!(cena.autenticou.get(), 1, "a vaga sem autenticação tem que ser liberada uma vez só");
        // Passou do teto: recusa com a mensagem de tamanho.
        let mut enorme = format!("{{\"token\":\"{TOKEN}\",\"command\":\"x\",\"args\":\"").into_bytes();
        enorme.extend(std::iter::repeat_n(b'c', MAX_REQUEST_BYTES as usize + 10));
        let (resultado, _) = ler(enorme, 64 * 1024, 0);
        assert!(matches!(&resultado, Intake::Refused(m) if m.contains("demasiado grande")), "{resultado:?}");
    }

    #[test]
    fn um_byte_por_vez_nao_segura_a_vaga_alem_do_prazo_total() {
        // Antes da autenticação: 1 s por leitura, nunca chega ao token (que só termina depois do prazo).
        let (resultado, cena) = ler(pedido(TOKEN, "{}"), 1, 1_000);
        assert!(matches!(resultado, Intake::Closed | Intake::Refused(_)), "{resultado:?}");
        assert!(cena.relogio.get() <= TOKEN_DEADLINE_MS + 2_000, "segurou a conexão por {} ms", cena.relogio.get());
        // Depois do token: o resto também tem prazo total (não é por leitura).
        let (resultado, cena) = ler(pedido(TOKEN, &format!("\"{}\"", "d".repeat(200_000))), 512, 1_000);
        assert!(matches!(resultado, Intake::Closed | Intake::Refused(_)), "{resultado:?}");
        assert!(cena.relogio.get() <= REQUEST_DEADLINE_MS + 2_000, "segurou a conexão por {} ms", cena.relogio.get());
    }

    #[test]
    fn linha_em_branco_ou_fim_da_conexao_nao_respondem_nada() {
        assert_eq!(ler(b"\n".to_vec(), 16, 0).0, Intake::Closed);
        assert_eq!(ler(Vec::new(), 16, 0).0, Intake::Closed);
    }

    #[test]
    fn cada_canal_tem_as_proprias_vagas_e_as_sem_autenticacao_tem_teto() {
        let tcp = Slots::with_limits(8, 3);
        let credencial = Slots::with_limits(8, 3);
        let seguradas: Vec<_> = (0..3).map(|_| tcp.try_acquire().expect("dentro do teto")).collect();
        assert!(tcp.try_acquire().is_none(), "uma 4ª conexão sem autenticação no mesmo canal");
        // O canal de credencial não paga pelo TCP.
        let mut autenticadas: Vec<_> = (0..3).map(|_| credencial.try_acquire().expect("o outro canal está livre")).collect();
        // Quem autentica libera a vaga "sem autenticação" mas continua ocupando uma conexão.
        for vaga in autenticadas.iter_mut() {
            vaga.authenticated();
        }
        let mais: Vec<_> = (0..5)
            .map(|_| {
                let mut vaga = credencial.try_acquire().expect("as autenticadas abrem espaço");
                vaga.authenticated();
                vaga
            })
            .collect();
        assert!(credencial.try_acquire().is_none(), "o teto de conexões abertas vale");
        drop(mais);
        drop(autenticadas);
        assert!(credencial.try_acquire().is_some(), "soltar a vaga devolve o espaço");
        drop(seguradas);
        assert!(tcp.try_acquire().is_some());
    }

    #[test]
    fn o_servidor_e_o_canal_de_credencial_usam_a_entrada_com_limites() {
        let server = include_str!("server.rs");
        let transport = include_str!("transport.rs");
        assert!(server.contains("intake::read_request("), "handle_connection não lê o pedido pela entrada limitada");
        assert!(!server.contains(".take(MAX_REQUEST_BYTES).read_line("), "sobrou a leitura de 8 MiB antes do token");
        // Cada canal com as suas vagas: dois `Slots::new()` em `try_start`, um para cada canal, e nada de contador solto.
        assert_eq!(server.matches("Slots::new()").count(), 2, "o TCP e o canal de credencial deixaram de ter vagas próprias");
        for fonte in [server, transport] {
            assert!(!fonte.contains("AtomicUsize"), "sobrou um contador de conexões fora do `intake`");
        }
    }

}

// ── F-05 e F-07: o arquivo do handshake ──────────────────────────────────────────────────────

mod arquivo_do_handshake {
    use super::super::protocol::{env_handshake_is_trusted, Handshake, PROTOCOL_VERSION};
    use std::path::{Path, PathBuf};

    fn pasta_de_teste(rotulo: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ags-{rotulo}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn handshake(pid: u32) -> Handshake {
        Handshake { port: 4242, token: "token-de-teste".into(), pid, protocol: PROTOCOL_VERSION, socket: None }
    }

    fn escreve(path: &Path, pid: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string(&handshake(pid)).unwrap()).unwrap();
    }

    // F-05

    #[cfg(unix)]
    #[test]
    fn o_handshake_nasce_0600_e_nao_segue_um_link_plantado_no_temporario() {
        use std::os::unix::fs::PermissionsExt;
        let raiz = pasta_de_teste("hs-link");
        let alvo = raiz.join("alvo.txt");
        std::fs::write(&alvo, "intocado").unwrap();
        let path = raiz.join("ipc").join("42.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // O temporário tem nome previsível (`<pid>.tmp-<pid>`): alguém com acesso à pasta planta um link ali.
        std::os::unix::fs::symlink(&alvo, raiz.join("ipc").join("42.tmp-42")).unwrap();
        super::super::server::write_handshake(&path, &handshake(42)).unwrap();
        assert_eq!(std::fs::read_to_string(&alvo).unwrap(), "intocado", "o handshake foi escrito através do link");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::read_to_string(&path).unwrap().contains("token-de-teste"));
        let _ = std::fs::remove_dir_all(&raiz);
    }

    #[cfg(unix)]
    #[test]
    fn as_pastas_que_o_handshake_cria_sao_so_do_dono() {
        use std::os::unix::fs::PermissionsExt;
        let raiz = pasta_de_teste("hs-pasta");
        let path = raiz.join("dados").join("ipc").join("7.json");
        super::super::server::write_handshake(&path, &handshake(7)).unwrap();
        for dir in [raiz.join("dados"), raiz.join("dados").join("ipc")] {
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700, "{}", dir.display());
        }
        // Uma pasta `ipc` que já existia (de uma versão antiga, 0755) também fecha.
        let antiga = raiz.join("antiga").join("ipc");
        std::fs::create_dir_all(&antiga).unwrap();
        std::fs::set_permissions(&antiga, std::fs::Permissions::from_mode(0o755)).unwrap();
        super::super::server::write_handshake(&antiga.join("8.json"), &handshake(8)).unwrap();
        assert_eq!(std::fs::metadata(&antiga).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&raiz);
    }

    #[test]
    fn o_handshake_e_criado_ja_com_o_modo_e_sem_escrever_antes_do_chmod() {
        let server = include_str!("server.rs");
        let inicio = server.find("pub(super) fn write_handshake(").unwrap();
        let corpo = &server[inicio..inicio + server[inicio..].find("\n}\n").unwrap()];
        assert!(server.contains("create_new(true)") && server.contains("options.mode(0o600)"), "o temporário não nasce 0600 de forma atômica");
        assert!(corpo.contains("create_private_file(&tmp)"), "write_handshake não usa a criação atômica");
        assert!(!corpo.contains("std::fs::write(") && !corpo.contains("set_permissions(&tmp"), "o handshake é escrito com a permissão padrão antes do chmod");
    }

    // F-07

    #[test]
    fn so_um_pid_json_vivo_dentro_de_ipc_vale_como_handshake_do_ambiente() {
        let raiz = pasta_de_teste("hs-env");
        let ipc = raiz.join("ipc");
        let roots = [ipc.clone()];
        let vivo = |pid: u32| pid == 4242;
        let confia = |p: &Path| env_handshake_is_trusted(p, &roots, &vivo);

        let bom = ipc.join("4242.json");
        escreve(&bom, 4242);
        assert!(confia(&bom), "o handshake de uma instância viva foi recusado");

        // Fora da pasta das instâncias: um listener escolhido por quem definiu o ambiente.
        let fora = raiz.join("fora").join("4242.json");
        escreve(&fora, 4242);
        assert!(!confia(&fora), "caminho fora de ipc/");
        // Subpasta de ipc/ não é ipc/.
        let fundo = ipc.join("sub").join("4242.json");
        escreve(&fundo, 4242);
        assert!(!confia(&fundo), "subpasta de ipc/");
        // O nome do arquivo tem que ser o PID que está dentro dele.
        let nome = ipc.join("nome.json");
        escreve(&nome, 4242);
        assert!(!confia(&nome), "nome que não é um PID");
        let trocado = ipc.join("9999.json");
        escreve(&trocado, 4242);
        assert!(!confia(&trocado), "PID do nome diferente do PID do arquivo");
        // PID morto: sobra de uma instância que já saiu.
        let morto = ipc.join("5555.json");
        escreve(&morto, 5555);
        assert!(!confia(&morto), "instância morta");
        // Lixo e arquivo ausente.
        let lixo = ipc.join("6666.json");
        std::fs::write(&lixo, "não é json").unwrap();
        assert!(!confia(&lixo));
        assert!(!confia(&ipc.join("1.json")));
        let _ = std::fs::remove_dir_all(&raiz);
    }

    #[cfg(unix)]
    #[test]
    fn um_link_dentro_de_ipc_que_aponta_para_fora_nao_vale() {
        let raiz = pasta_de_teste("hs-env-link");
        let ipc = raiz.join("ipc");
        let alheio = raiz.join("alheio").join("4242.json");
        escreve(&alheio, 4242);
        std::fs::create_dir_all(&ipc).unwrap();
        std::os::unix::fs::symlink(&alheio, ipc.join("4242.json")).unwrap();
        assert!(!env_handshake_is_trusted(&ipc.join("4242.json"), &[ipc.clone()], &|_| true), "o link para fora foi aceito");
        let _ = std::fs::remove_dir_all(&raiz);
    }

    #[test]
    fn a_cli_so_usa_o_handshake_do_ambiente_depois_de_validar() {
        let protocolo = include_str!("protocol.rs");
        let inicio = protocolo.find("pub fn client_handshake_path()").unwrap();
        let corpo = &protocolo[inicio..inicio + protocolo[inicio..].find("\n}\n").unwrap()];
        assert!(corpo.contains("env_handshake_is_trusted("), "AGS_HANDSHAKE é aceito sem validar a origem");
        assert!(!corpo.contains(".filter(|p| p.is_file())"), "sobrou o filtro antigo (só existe)");
    }
}

// ── F-09 completo: autorização por método (`ipc/authz.rs`) ──────────────────────────────────
//
// A tabela única de classes (livre, escopo, pessoa, pessoa-ou-escopo) é consultada no começo do despachador. Estes testes
// provam: (1) todo método do despachador tem classe e método novo sem classe é recusado; (2) cada classe aceita e recusa o
// que deve, por método sensível; (3) os fluxos que a skill documenta continuam passando no escopo certo.

mod autorizacao {
    use super::super::authz::{self, Class, Target};
    use super::json;
    use crate::canvas::{Board, Boards};
    use crate::terminal::Principal;
    use serde_json::Value;
    use std::cell::Cell;

    /// A missão `missao-1`: o orquestrador `lead` liga `m1`, `m2`, um portal, um aparelho, uma nota e uma conversa filha.
    /// `solta` está em outro canvas e não liga a ninguém.
    fn mundo() -> Boards {
        let missao: Board = serde_json::from_value(json!({
            "edges": [
                { "id": "e1", "a": "lead", "b": "m1" },
                { "id": "e2", "a": "lead", "b": "m2" },
                { "id": "e3", "a": "lead", "b": "portal-web" },
                { "id": "e4", "a": "lead", "b": "portal-iphone" },
                { "id": "e5", "a": "lead", "b": "thread:filha" },
                { "id": "e6", "a": "lead", "b": "note-plano" }
            ],
            "orchestrators": ["lead"],
            "nodes": { "lead": {}, "m1": {}, "m2": {}, "thread:filha": {} },
            "portals": { "portal-web": { "name": "Web" }, "portal-iphone": { "name": "iPhone", "kind": "ios" } },
            "notes": { "note-plano": { "name": "Plano" } }
        }))
        .unwrap();
        let solta: Board = serde_json::from_value(json!({ "nodes": { "solta": {}, "aba-da-pessoa": {} } })).unwrap();
        Boards::from([("/repo#m:missao-1".to_string(), missao), ("/outra".to_string(), solta)])
    }

    fn aba(id: &str) -> Result<Principal, String> {
        Ok(Principal::Tab(id.into()))
    }
    fn tarefa(id: &str) -> Result<Principal, String> {
        Ok(Principal::Task(id.into()))
    }
    fn fora() -> Result<Principal, String> {
        Ok(Principal::Outside)
    }

    /// Roda a autorização. `abriu` = pares `(recurso, quem abriu)`.
    fn decide(comando: &str, args: Value, quem: Result<Principal, String>, abriu: &[(&str, &str)]) -> Result<Value, String> {
        let boards = mundo();
        authz::authorize(comando, &args, || quem, || boards, &|id| abriu.iter().find(|(r, _)| *r == id).map(|(_, o)| o.to_string()))
    }

    fn passa(comando: &str, args: Value, quem: Result<Principal, String>) -> Value {
        decide(comando, args, quem, &[]).unwrap_or_else(|e| panic!("{comando} deveria passar: {e}"))
    }

    fn recusa(comando: &str, args: Value, quem: Result<Principal, String>) -> String {
        decide(comando, args, quem, &[]).err().unwrap_or_else(|| panic!("{comando} deveria ser recusado"))
    }

    fn com_prefixo(prefixo: &str) -> Vec<&'static str> {
        authz::METHODS.iter().map(|(m, _)| *m).filter(|m| m.starts_with(prefixo)).collect()
    }

    // ── 1. A tabela é completa e fecha por padrão ──

    /// Os métodos que o `match` do despachador atende, lidos do código.
    fn bracos_do_despachador() -> Vec<String> {
        let fonte = include_str!("commands/dispatch.rs");
        let inicio = fonte.find("let result = match command {").expect("o match do despachador mudou de forma");
        let fim = fonte.find("other => Err(format!(\"Comando desconhecido").expect("o braço final mudou de forma");
        fonte[inicio..fim]
            .lines()
            .map(str::trim_start)
            .filter(|l| l.starts_with('"'))
            .filter_map(|l| {
                let nome = &l[1..1 + l[1..].find('"')?];
                l[nome.len() + 2..].trim_start().starts_with("=>").then(|| nome.to_string())
            })
            .collect()
    }

    #[test]
    fn todo_metodo_do_despachador_tem_classe_e_a_tabela_nao_tem_metodo_fantasma() {
        let bracos = bracos_do_despachador();
        assert!(bracos.len() > 200, "a leitura do despachador achou só {} braços", bracos.len());
        let sem_classe: Vec<_> = bracos.iter().filter(|m| authz::class_of(m).is_none()).collect();
        assert!(sem_classe.is_empty(), "método novo sem classe de autorização (adicione em ipc/authz.rs): {sem_classe:?}");
        // `approval.*` não tem braço (recusado antes do `match`), mas tem classe.
        let mut esperados: Vec<String> = bracos.clone();
        esperados.extend(["approval.decide".to_string(), "approval.list".to_string()]);
        let fantasmas: Vec<_> = authz::METHODS.iter().map(|(m, _)| *m).filter(|m| !esperados.iter().any(|e| e == m)).collect();
        assert!(fantasmas.is_empty(), "classe para método que o despachador não atende: {fantasmas:?}");
        let mut nomes: Vec<_> = authz::METHODS.iter().map(|(m, _)| *m).collect();
        nomes.sort_unstable();
        let total = nomes.len();
        nomes.dedup();
        assert_eq!(nomes.len(), total, "método com duas entradas na tabela");
        assert_eq!(total, bracos.len() + 2);
    }

    #[test]
    fn metodo_sem_classe_e_recusado_para_qualquer_chamador() {
        for quem in [fora(), aba("m1"), tarefa("t1")] {
            let erro = recusa("novo.metodo", json!({}), quem);
            assert!(erro.contains("novo.metodo") && erro.contains("classe"), "{erro}");
        }
        assert!(authz::class_of("novo.metodo").is_none());
    }

    #[test]
    fn a_contagem_por_classe_e_a_documentada() {
        let (mut livre, mut escopo, mut pessoa, mut papel) = (0, 0, 0, 0);
        for (_, classe) in authz::METHODS {
            match classe {
                Class::Free => livre += 1,
                Class::Scope(_) => escopo += 1,
                Class::Person(_) => pessoa += 1,
                Class::PersonOrScope(_) => papel += 1,
            }
        }
        // O mesmo número está em docs/decisoes/HOST_REMOTO.md (F-09 e Anexo A).
        assert_eq!((livre, escopo, pessoa, papel), (LIVRE, ESCOPO, PESSOA, PAPEL), "atualize o HOST_REMOTO.md junto com a tabela");
    }
    const LIVRE: usize = 27;
    const ESCOPO: usize = 188;
    const PESSOA: usize = 4;
    const PAPEL: usize = 2;

    #[test]
    fn o_despachador_aplica_a_tabela_antes_de_qualquer_comando() {
        let fonte = include_str!("commands/dispatch.rs");
        let tabela = fonte.find("crate::ipc::authz::authorize(").expect("o despachador não consulta a tabela de autorização");
        let prova = fonte.find("crate::ipc::guard::task_proof_error(args").expect("a prova do taskId sumiu");
        let politica = fonte.find("guard_task(&conn, args.get(\"taskId\")").expect("a política da tarefa mudou de forma");
        let braco = fonte.find("let result = match command {").unwrap();
        assert!(prova < tabela && tabela < politica && tabela < braco, "a tabela precisa vir depois da prova do taskId e antes do resto");
        // O resto do despachador usa os argumentos com a identidade provada, não os do chamador.
        assert!(fonte[tabela..braco].contains("let args = &args;") || fonte[tabela..braco].contains("let args = &"), "o despachador segue usando os argumentos declarados");
    }

    // ── 2. Livre ──

    #[test]
    fn livre_nao_pede_nem_resolve_identidade() {
        for metodo in ["app.status", "agent.list", "account.list", "tab.list", "chat.list", "events.since", "skill.list", "workspace.status", "mcp.cancel"] {
            let chamadas = Cell::new(0);
            let boards = mundo();
            let args = json!({ "x": 1 });
            let saida = authz::authorize(metodo, &args, || { chamadas.set(chamadas.get() + 1); Err("sem identidade".into()) }, || boards, &|_| None);
            assert_eq!(saida.unwrap(), args, "{metodo}");
            assert_eq!(chamadas.get(), 0, "{metodo} resolveu a identidade sem precisar");
        }
    }

    // ── 3. Pessoa ──

    #[test]
    fn pessoa_e_recusada_para_todo_chamador_e_a_mensagem_manda_para_a_tela() {
        for metodo in ["approval.decide", "approval.list", "memory.compact", "workspace.restore"] {
            assert!(matches!(authz::class_of(metodo), Some(Class::Person(_))), "{metodo}");
            for quem in [fora(), aba("lead"), tarefa("t1")] {
                let erro = recusa(metodo, json!({}), quem);
                assert!(erro.contains("interface") || erro.contains("tela"), "{metodo}: {erro}");
            }
        }
    }

    // ── 4. Escopo de aba (tab.output, tab.close, tab.state, tab.send, watch, replay) ──

    const POR_ABA: [&str; 8] = ["tab.output", "tab.close", "tab.state", "tab.send", "watch.add", "watch.remove", "replay.start", "replay.stop"];

    #[test]
    fn um_agente_age_em_si_nos_ligados_a_ele_e_nas_abas_que_ele_abriu() {
        for metodo in POR_ABA {
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::Tab("tab")))), "{metodo} não está no escopo de aba");
            let ok = |de: &str, alvo: &str, abriu: &[(&str, &str)]| decide(metodo, json!({ "tab": alvo }), aba(de), abriu).is_ok();
            assert!(ok("m1", "m1", &[]), "{metodo}: a si mesmo");
            assert!(ok("m1", "lead", &[]), "{metodo}: o orquestrador ligado a ele");
            assert!(ok("m1", "m2", &[]), "{metodo}: o outro integrante da estrela");
            assert!(ok("lead", "m2", &[]), "{metodo}: o orquestrador alcança o time");
            assert!(ok("solta", "terminal-que-abri", &[("terminal-que-abri", "solta")]), "{metodo}: a aba que ele abriu");
        }
    }

    #[test]
    fn um_agente_nao_age_em_aba_de_outro_nem_da_pessoa() {
        for metodo in POR_ABA {
            let erro = decide(metodo, json!({ "tab": "aba-da-pessoa" }), aba("m1"), &[]).unwrap_err();
            assert!(erro.contains("aba-da-pessoa"), "{metodo}: a recusa diz qual aba: {erro}");
            assert!(decide(metodo, json!({ "tab": "solta" }), aba("m1"), &[]).is_err(), "{metodo}: aba de outro canvas");
            assert!(decide(metodo, json!({ "tab": "x" }), aba("m1"), &[("x", "outro-agente")]).is_err(), "{metodo}: aba aberta por outro");
            assert!(decide(metodo, json!({ "tab": "lead" }), aba("solta"), &[]).is_err(), "{metodo}: sem ligação alguma");
            assert!(decide(metodo, json!({ "tab": "m1" }), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa da Frota não tem aba");
            assert!(decide(metodo, json!({}), aba("m1"), &[]).is_err(), "{metodo}: sem alvo não há o que provar");
        }
    }

    #[test]
    fn a_pessoa_no_proprio_terminal_continua_com_o_acesso_que_tem() {
        for metodo in POR_ABA {
            assert!(decide(metodo, json!({ "tab": "aba-da-pessoa" }), fora(), &[]).is_ok(), "{metodo}");
        }
    }

    #[test]
    fn identidade_que_nao_se_prova_nao_chega_ao_handler() {
        for metodo in ["tab.output", "portal.list", "device.list", "chat.show"] {
            let erro = decide(metodo, json!({ "tab": "m1", "thread": "filha" }), Err("ADE_TAB_ID não corresponde a este terminal.".into()), &[]).unwrap_err();
            assert!(erro.contains("ADE_TAB_ID"), "{metodo}: {erro}");
        }
    }

    // ── 5. Conversas do modo chat ──

    #[test]
    fn conversa_so_dentro_do_alcance_de_quem_chama() {
        for metodo in ["chat.show", "chat.send", "chat.wait", "chat.stop", "chat.open", "chat.settle", "chat.goal", "chat.compact"] {
            let ok = |de: &str, alvo: &str, abriu: &[(&str, &str)]| decide(metodo, json!({ "thread": alvo }), aba(de), abriu).is_ok();
            assert!(ok("lead", "filha", &[]), "{metodo}: conversa ligada no canvas");
            assert!(ok("thread:eu", "eu", &[]), "{metodo}: a própria conversa");
            assert!(ok("m1", "nova", &[("thread:nova", "m1")]), "{metodo}: a conversa que ele abriu com `chat new`");
            assert!(!ok("m1", "da-pessoa", &[]), "{metodo}: conversa da pessoa");
            assert!(!ok("m1", "nova", &[("thread:nova", "m2")]), "{metodo}: conversa aberta por outro");
            assert!(decide(metodo, json!({ "thread": "da-pessoa" }), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa da Frota");
            assert!(decide(metodo, json!({ "thread": "da-pessoa" }), fora(), &[]).is_ok(), "{metodo}: a pessoa em terminal próprio");
        }
    }

    #[test]
    fn chat_pending_sem_conversa_so_para_quem_esta_fora_e_chat_list_e_livre() {
        assert!(decide("chat.pending", json!({}), aba("m1"), &[]).unwrap_err().contains("--thread"));
        assert!(decide("chat.pending", json!({}), aba("m1"), &[]).is_err(), "um agente lista os pedidos de todas as conversas");
        assert!(decide("chat.pending", json!({ "thread": "filha" }), aba("m1"), &[]).is_ok());
        assert!(decide("chat.pending", json!({ "thread": "da-pessoa" }), aba("m1"), &[]).is_err());
        assert!(decide("chat.pending", json!({}), fora(), &[]).is_ok());
        assert!(matches!(authz::class_of("chat.list"), Some(Class::Free)));
    }

    // ── 6. O chamador provado (portais, aparelhos, notas, pares, equipe…) ──

    #[test]
    fn portais_e_aparelhos_exigem_o_chamador_provado_e_o_handler_so_enxerga_o_alcance_dele() {
        let mut metodos = com_prefixo("portal.");
        metodos.extend(com_prefixo("device."));
        assert!(metodos.len() >= 37, "{}", metodos.len());
        for metodo in metodos {
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::Caller))), "{metodo}");
            // Aceita o agente provado e entrega o `from` provado ao handler (que resolve o alvo pelo canvas dele).
            let entregue = passa(metodo, json!({ "name": "Web" }), aba("m1"));
            assert_eq!(entregue["from"], "m1", "{metodo}");
            // Um `from` declarado de outra aba nunca chega ao handler.
            assert!(decide(metodo, json!({ "from": "lead" }), aba("m1"), &[]).unwrap_err().contains("lead"), "{metodo}");
            // Tarefa da Frota e quem não prova nada: recusados.
            assert!(decide(metodo, json!({}), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa");
            assert!(decide(metodo, json!({}), fora(), &[]).is_err(), "{metodo}: sem identidade o handler já não tem o que resolver");
        }
    }

    #[test]
    fn os_handlers_de_portal_e_aparelho_resolvem_o_alvo_pelo_canvas_do_chamador() {
        let portais = include_str!("commands/portals.rs");
        assert!(portais.matches("let from = caller(args)?;").count() >= 3, "portais não partem do chamador");
        assert!(portais.contains("fn reachable(boards: &Boards, from: &str)"), "o alcance dos portais mudou de forma");
        let aparelhos = include_str!("commands/devices.rs");
        for funcao in ["pub(super) fn device_list(", "pub(super) fn device_create(", "pub(super) fn device_action("] {
            let inicio = aparelhos.find(funcao).unwrap_or_else(|| panic!("{funcao} mudou de forma"));
            let corpo = &aparelhos[inicio..inicio + 1200.min(aparelhos.len() - inicio)];
            assert!(corpo.contains("caller(args)?"), "{funcao} não parte do chamador");
        }
        // As confirmações por aparelho (confiança persistente, controles sensíveis) seguem no `device_action`.
        assert!(aparelhos.contains("ios_target(") || aparelhos.contains("resolve_with_physical"), "o alvo do aparelho não é resolvido pelo alcance");
    }

    #[test]
    fn pares_notas_equipe_e_chat_com_a_pessoa_exigem_o_chamador_provado() {
        for metodo in ["peer.ask", "peer.tell", "peer.deliver", "peer.handoff", "peer.check", "peer.recruit", "peer.connect", "peer.disconnect", "peer.role", "peer.list", "peer.pending", "peer.queue", "peer.receipt", "ci.watch", "notify.send", "note.list", "note.read", "note.create", "note.write", "note.edit", "team.list", "team.candidates", "team.create", "team.link", "team.unlink", "team.role", "team.delegate", "say.send", "recall.get", "floor.create", "floor.list", "role.create", "role.edit", "routine.list", "routine.show", "routine.create", "routine.edit", "routine.enable", "routine.disable", "routine.run", "routine.delete", "secret.request", "secret.consume", "secret.revoke", "sim.act", "desk.act", "swarm.note", "swarm.promote", "swarm.question", "swarm.read", "memory.search", "memory.suggest", "memory.history", "memory.index", "memory.open", "memory.usage", "memory.export"] {
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::Caller))), "{metodo}");
            assert_eq!(passa(metodo, json!({}), aba("m1"))["from"], "m1", "{metodo}");
            assert!(decide(metodo, json!({ "from": "lead" }), aba("m1"), &[]).is_err(), "{metodo}: from forjado");
            assert!(decide(metodo, json!({}), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa");
            assert!(decide(metodo, json!({}), fora(), &[]).is_err(), "{metodo}: fora");
        }
    }

    #[test]
    fn criar_aba_conversa_design_e_workspace_servem_ao_agente_provado_e_a_pessoa_fora() {
        for metodo in ["tab.create", "chat.new", "design.create", "design.update", "design.delete", "design.open", "skill.install", "skill.new", "skill.edit", "window.create", "workspace.open", "pool.create"] {
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::CallerOrOutside))), "{metodo}");
            assert_eq!(passa(metodo, json!({}), aba("m1"))["from"], "m1", "{metodo}");
            assert!(passa(metodo, json!({ "x": 1 }), fora()).get("from").is_none(), "{metodo}: a pessoa fora segue sem `from`");
            assert!(decide(metodo, json!({}), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa");
            assert!(decide(metodo, json!({ "from": "lead" }), aba("m1"), &[]).is_err(), "{metodo}: from forjado");
        }
    }

    #[test]
    fn um_agente_nao_fecha_o_workspace_atual_so_a_pessoa() {
        assert!(decide("workspace.open", json!({ "workspace": "w", "closeCurrent": true }), aba("m1"), &[]).unwrap_err().contains("terminais"));
        assert!(decide("workspace.open", json!({ "workspace": "w", "closeCurrent": true }), fora(), &[]).is_ok());
        assert!(decide("workspace.open", json!({ "workspace": "w" }), aba("m1"), &[]).is_ok());
    }

    // ── 7. Frota: tarefa, run, navegador, forge ──

    #[test]
    fn frota_aceita_a_tarefa_a_aba_e_a_pessoa_mas_nunca_a_identidade_trocada() {
        for metodo in ["run.status", "run.result", "run.plan", "run.cancelTask", "run.await", "browser.run", "forge.run", "user.ask", "gemini.consult", "run.approve", "run.handoff"] {
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::Fleet))), "{metodo}");
            assert!(decide(metodo, json!({ "taskId": "t1" }), tarefa("t1"), &[]).is_ok(), "{metodo}: a própria tarefa");
            assert!(decide(metodo, json!({ "tabId": "m1" }), aba("m1"), &[]).is_ok(), "{metodo}: a própria aba");
            assert!(decide(metodo, json!({ "cwd": "/repo" }), fora(), &[]).is_ok(), "{metodo}: a pessoa resolvendo pela pasta");
            assert!(decide(metodo, json!({ "taskId": "outra" }), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa agindo como outra");
            assert!(decide(metodo, json!({ "tabId": "lead" }), aba("m1"), &[]).is_err(), "{metodo}: aba agindo como outra");
            assert!(decide(metodo, json!({ "tabId": "m1" }), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa não declara aba");
        }
    }

    #[test]
    fn as_ferramentas_de_memoria_da_tarefa_so_servem_a_propria_tarefa() {
        for metodo in ["memory.list", "memory.get", "memory.searchApproved", "memory.propose", "memory.update", "memory.delete", "memory.promoteFact", "memory.workspaceHistory"] {
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::Task))), "{metodo}");
            assert!(decide(metodo, json!({ "taskId": "t1" }), tarefa("t1"), &[]).is_ok(), "{metodo}");
            assert!(decide(metodo, json!({}), aba("m1"), &[]).is_err(), "{metodo}: aba");
            assert!(decide(metodo, json!({}), fora(), &[]).is_err(), "{metodo}: fora");
            assert!(decide(metodo, json!({ "taskId": "outra" }), tarefa("t1"), &[]).is_err(), "{metodo}");
        }
    }

    // ── 8. Missão ──

    #[test]
    fn missao_so_a_do_proprio_quadro_e_so_a_coroa_aplica_ou_limpa() {
        for metodo in ["mission.status", "mission.wait", "mission.review", "mission.timings", "mission.precheck", "mission.startcheck", "mission.efficiency"] {
            assert!(decide(metodo, json!({ "mission": "missao-1" }), aba("m1"), &[]).is_ok(), "{metodo}: a missão dele");
            assert!(decide(metodo, json!({ "mission": "outra" }), aba("m1"), &[]).is_err(), "{metodo}: missão alheia");
            assert!(decide(metodo, json!({ "mission": "missao-1" }), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa");
            assert!(decide(metodo, json!({ "mission": "qualquer" }), fora(), &[]).is_ok(), "{metodo}: CI e a pessoa fora");
        }
        for metodo in ["mission.accept", "mission.apply", "mission.redeliver", "mission.cleanup"] {
            assert!(decide(metodo, json!({ "mission": "missao-1" }), aba("lead"), &[]).is_ok(), "{metodo}: a coroa da missão");
            assert!(decide(metodo, json!({ "mission": "missao-1" }), aba("m1"), &[]).unwrap_err().contains("orquestrador"), "{metodo}: integrante");
            assert!(decide(metodo, json!({ "mission": "outra" }), aba("lead"), &[]).is_err(), "{metodo}: coroa de outra missão");
            assert!(decide(metodo, json!({ "mission": "x" }), fora(), &[]).is_ok(), "{metodo}: CI");
        }
    }

    #[test]
    fn criar_ou_iniciar_missao_e_apagar_worktrees_e_config_so_para_quem_esta_fora() {
        for metodo in ["mission.create", "mission.run", "mission.start", "worktrees.prune", "pool.delete"] {
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::Outside))), "{metodo}");
            assert!(decide(metodo, json!({}), fora(), &[]).is_ok(), "{metodo}: a pessoa/CI fora da árvore do ADE");
            for quem in [aba("lead"), aba("m1"), tarefa("t1")] {
                let erro = decide(metodo, json!({}), quem, &[]).unwrap_err();
                assert!(erro.contains("pessoa"), "{metodo}: {erro}");
            }
        }
    }

    // ── 9. Pessoa-ou-escopo: o orquestrador provado, ou a pessoa pela tela ──

    #[test]
    fn decidir_e_responder_pelo_integrante_e_do_orquestrador_ou_da_pessoa_pela_tela() {
        for metodo in ["fix.decide", "peer.answer"] {
            assert!(matches!(authz::class_of(metodo), Some(Class::PersonOrScope(_))), "{metodo}");
            assert!(decide(metodo, json!({}), aba("lead"), &[]).is_ok(), "{metodo}: o orquestrador");
            assert!(decide(metodo, json!({}), aba("m1"), &[]).unwrap_err().contains("orquestrador"), "{metodo}: integrante");
            assert!(decide(metodo, json!({}), tarefa("t1"), &[]).is_err(), "{metodo}: tarefa");
            let tela = decide(metodo, json!({}), fora(), &[]).unwrap_err();
            assert!(tela.contains("tela"), "{metodo}: a pessoa decide pela tela: {tela}");
        }
    }

    // ── 10. O despachador usa a identidade provada ──

    #[test]
    fn a_tarefa_provada_entra_nos_argumentos_e_o_taskid_declarado_de_outra_e_recusado() {
        // Sem `taskId` o handler nunca resolvia a política (Dreamer somente leitura): agora entra o provado.
        let entregue = passa("run.status", json!({}), tarefa("t1"));
        assert_eq!(entregue["taskId"], "t1");
        assert!(entregue.get("tabId").is_none());
    }

    #[test]
    fn a_aba_provada_nunca_e_substituida_por_outra_no_from() {
        assert_eq!(passa("peer.tell", json!({ "from": "m1", "to": "lead", "text": "oi" }), aba("m1"))["from"], "m1");
        assert!(decide("peer.tell", json!({ "from": "lead", "to": "m1", "text": "oi" }), aba("m1"), &[]).is_err());
    }

    // ── 11. Os fluxos da skill continuam funcionando no escopo certo ──

    /// `(comando, argumentos)` que um agente da missão (`m1`, integrante) usa, como a skill documenta. Cada um passa.
    fn fluxos_do_integrante() -> Vec<(&'static str, Value)> {
        vec![
            // Abrir abas, rodar, ler (as abas que ele abriu entram em `ABRIU`).
            ("tab.create", json!({ "cwd": "/repo", "agent": "bash", "initPrompt": "bun dev" })),
            ("tab.list", json!({})),
            ("tab.output", json!({ "tab": "t-abriu" })),
            ("tab.send", json!({ "tab": "t-abriu", "text": "cargo test" })),
            ("tab.state", json!({ "tab": "t-abriu" })),
            ("tab.close", json!({ "tab": "t-abriu" })),
            ("watch.add", json!({ "tab": "t-abriu", "idle": 5 })),
            ("watch.wait", json!({ "timeout": 120 })),
            ("watch.list", json!({})),
            ("watch.remove", json!({ "tab": "t-abriu" })),
            ("events.wait", json!({ "after": 0 })),
            ("events.since", json!({ "after": 0 })),
            // Conversar com os ligados no canvas.
            ("peer.list", json!({})),
            ("peer.ask", json!({ "to": "lead", "text": "?" })),
            ("peer.tell", json!({ "to": "lead", "text": "pronto" })),
            ("peer.check", json!({})),
            ("peer.deliver", json!({ "to": "lead", "text": "{}" })),
            ("peer.handoff", json!({ "to": "lead", "text": "{}" })),
            ("peer.queue", json!({})),
            ("peer.receipt", json!({ "id": "1" })),
            ("peer.pending", json!({})),
            ("peer.recruit", json!({ "name": "Tests", "agent": "codex" })),
            ("peer.connect", json!({ "to": "m2" })),
            ("peer.disconnect", json!({ "to": "m2" })),
            ("peer.role", json!({ "to": "m2", "role": "reviewer" })),
            ("ci.watch", json!({ "pr": 1 })),
            ("notify.send", json!({ "message": "pronto" })),
            // Time do modo chat.
            ("team.list", json!({})),
            ("team.candidates", json!({})),
            ("team.link", json!({ "to": "m2" })),
            ("team.unlink", json!({ "to": "m2" })),
            ("team.role", json!({ "to": "m2", "role": "x" })),
            ("team.delegate", json!({ "to": "m2", "task": "x", "client_request_id": "a" })),
            // Navegador e aparelhos do canvas.
            ("portal.list", json!({})),
            ("portal.create", json!({ "name": "Docs", "url": "https://example.com" })),
            ("portal.open", json!({ "url": "https://example.com" })),
            ("portal.navigate", json!({ "name": "Web", "url": "https://example.com" })),
            ("portal.snapshot", json!({ "name": "Web" })),
            ("portal.click", json!({ "name": "Web", "target": "e1" })),
            ("portal.type", json!({ "name": "Web", "target": "e1", "text": "x" })),
            ("portal.press", json!({ "name": "Web", "key": "Enter" })),
            ("portal.act", json!({ "name": "Web", "goal": "abrir" })),
            ("portal.reset", json!({ "name": "Web" })),
            ("portal.close", json!({ "name": "Web" })),
            ("device.list", json!({})),
            ("device.create", json!({ "name": "iPhone", "ios": true })),
            ("device.start", json!({ "name": "iPhone" })),
            ("device.shot", json!({ "name": "iPhone" })),
            ("device.tap", json!({ "name": "iPhone", "x": 1, "y": 2 })),
            ("device.apps", json!({ "name": "iPhone" })),
            ("device.act", json!({ "name": "iPhone", "action": "tap" })),
            ("sim.act", json!({ "name": "iPhone", "goal": "abrir ajustes" })),
            ("desk.act", json!({ "goal": "abrir" })),
            // Notas, designs, chat com a pessoa, rotinas, andares, papéis.
            ("note.list", json!({})),
            ("note.read", json!({ "name": "Plano" })),
            ("note.write", json!({ "name": "Plano", "content": "x" })),
            ("note.edit", json!({ "name": "Plano", "old": "a", "new": "b" })),
            ("design.create", json!({ "title": "Checkout" })),
            ("design.list", json!({})),
            ("design.artboard.add", json!({ "designId": "d1", "title": "Cart" })),
            ("design.update", json!({ "artboardId": "a1", "html": "<p/>" })),
            ("design.view", json!({})),
            ("design.open", json!({ "designId": "d1" })),
            ("say.send", json!({ "text": "oi" })),
            ("recall.get", json!({})),
            ("routine.create", json!({ "name": "Tests", "text": "x", "at": "09:00" })),
            ("routine.list", json!({})),
            ("routine.edit", json!({ "name": "Tests", "text": "y" })),
            ("floor.create", json!({ "name": "Refactor" })),
            ("floor.list", json!({})),
            ("role.list", json!({})),
            ("role.show", json!({ "name": "reviewer" })),
            ("role.create", json!({ "name": "Sec", "text": "x" })),
            ("role.edit", json!({ "name": "Sec", "text": "y" })),
            // Skills, contas, catálogos, workspaces.
            ("skill.list", json!({})),
            ("skill.search", json!({ "query": "react" })),
            ("skill.install", json!({ "skill": "git-helper" })),
            ("skill.show", json!({ "skill": "git-helper" })),
            ("skill.new", json!({ "name": "x", "content": "y" })),
            ("skill.edit", json!({ "skill": "x", "content": "y" })),
            ("agent.list", json!({})),
            ("account.list", json!({})),
            ("pool.list", json!({})),
            ("pool.create", json!({ "name": "Work", "agent": "claude-code" })),
            ("prelaunch.list", json!({})),
            ("workspace.list", json!({})),
            ("workspace.status", json!({})),
            ("workspace.open", json!({ "workspace": "client-project" })),
            ("window.list", json!({})),
            ("window.create", json!({})),
            ("app.status", json!({})),
            // Conversas do modo chat que ele abriu.
            ("chat.list", json!({})),
            ("chat.providers", json!({})),
            ("chat.new", json!({ "text": "mapear", "cwd": "/repo" })),
            ("chat.wait", json!({ "thread": "c-abriu" })),
            ("chat.show", json!({ "thread": "c-abriu" })),
            ("chat.send", json!({ "thread": "c-abriu", "text": "agora o teste" })),
            ("chat.stop", json!({ "thread": "c-abriu" })),
            ("chat.compact", json!({ "thread": "c-abriu" })),
            ("chat.goal", json!({ "thread": "c-abriu", "action": "show" })),
            ("chat.pending", json!({ "thread": "c-abriu" })),
            // Memória e swarm da missão, correções, frota pela CLI.
            ("memory.search", json!({ "query": "auth" })),
            ("memory.suggest", json!({ "key": "k", "body": "b" })),
            ("memory.index", json!({})),
            ("memory.open", json!({ "path": "MEMORY.md" })),
            ("memory.history", json!({ "key": "k", "scope": "mission" })),
            ("memory.usage", json!({})),
            ("memory.export", json!({})),
            ("swarm.read", json!({})),
            ("swarm.note", json!({ "body": "x" })),
            ("swarm.question", json!({ "body": "x" })),
            ("swarm.promote", json!({ "note": "n", "key": "k" })),
            ("fix.list", json!({})),
            ("mission.precheck", json!({ "mission": "missao-1" })),
            ("mission.timings", json!({ "mission": "missao-1" })),
            ("mission.efficiency", json!({ "mission": "missao-1" })),
            ("mission.review", json!({ "mission": "missao-1" })),
            ("mission.startcheck", json!({ "mission": "missao-1" })),
            ("run.roster", json!({ "tabId": "m1" })),
            ("run.status", json!({ "tabId": "m1" })),
            ("run.result", json!({ "tabId": "m1", "task": "a" })),
            ("run.await", json!({ "tabId": "m1" })),
            ("run.facts", json!({ "tabId": "m1" })),
            ("run.addFact", json!({ "tabId": "m1", "body": "x" })),
            ("run.cancelTask", json!({ "tabId": "m1", "task": "a" })),
            ("run.rerouteTask", json!({ "tabId": "m1", "task": "a" })),
            ("run.plan", json!({ "tabId": "m1" })),
            ("browser.run", json!({ "tabId": "m1", "cwd": "/repo", "request": { "op": "snapshot" } })),
            ("forge.run", json!({ "tabId": "m1", "tool": "git_account" })),
            ("gemini.status", json!({ "tabId": "m1" })),
            ("user.ask", json!({ "tabId": "m1", "question": "?" })),
            ("secret.request", json!({ "label": "token" })),
            ("secret.revoke", json!({ "secretId": "s" })),
            ("mcp.cancel", json!({ "callId": "c" })),
        ]
    }

    #[test]
    fn os_fluxos_da_skill_passam_para_o_integrante_da_missao_no_escopo_dele() {
        let abriu = [("t-abriu", "m1"), ("thread:c-abriu", "m1")];
        for (comando, args) in fluxos_do_integrante() {
            decide(comando, args.clone(), aba("m1"), &abriu).unwrap_or_else(|e| panic!("o fluxo documentado `{comando}` quebrou para o integrante: {e}"));
        }
    }

    #[test]
    fn os_fluxos_do_orquestrador_passam_inclusive_decidir_aplicar_e_limpar() {
        for (comando, args) in [
            ("peer.answer", json!({ "to": "m1", "answer": "1" })),
            ("fix.decide", json!({ "scope": "mission:missao-1", "action": "accept" })),
            ("mission.apply", json!({ "mission": "missao-1" })),
            ("mission.accept", json!({ "mission": "missao-1", "task": "a" })),
            ("mission.cleanup", json!({ "mission": "missao-1" })),
            ("mission.redeliver", json!({ "mission": "missao-1" })),
            ("tab.output", json!({ "tab": "m2" })),
            ("tab.send", json!({ "tab": "m2", "text": "x" })),
            ("peer.recruit", json!({ "name": "Perf" })),
            ("floor.create", json!({ "name": "Refactor" })),
            ("portal.snapshot", json!({ "name": "Web" })),
            ("device.shot", json!({ "name": "iPhone" })),
            ("chat.show", json!({ "thread": "filha" })),
        ] {
            decide(comando, args.clone(), aba("lead"), &[]).unwrap_or_else(|e| panic!("`{comando}` quebrou para o orquestrador: {e}"));
        }
    }

    #[test]
    fn os_fluxos_do_agente_da_frota_passam_pela_tarefa_dele() {
        for (comando, args) in [
            ("run.roster", json!({ "taskId": "t1" })),
            ("run.status", json!({ "taskId": "t1" })),
            ("run.plan", json!({ "taskId": "t1" })),
            ("run.addTask", json!({ "taskId": "t1" })),
            ("run.delegateTask", json!({ "taskId": "t1" })),
            ("run.result", json!({ "taskId": "t1", "task": "a" })),
            ("run.await", json!({ "taskId": "t1" })),
            ("run.handoff", json!({ "taskId": "t1" })),
            ("run.addFact", json!({ "taskId": "t1" })),
            ("run.facts", json!({ "taskId": "t1" })),
            ("run.factBody", json!({ "taskId": "t1" })),
            ("run.cancelTask", json!({ "taskId": "t1" })),
            ("run.rerouteTask", json!({ "taskId": "t1" })),
            ("run.harnessGraph", json!({ "taskId": "t1" })),
            ("run.approve", json!({ "taskId": "t1" })),
            ("memory.list", json!({ "taskId": "t1" })),
            ("memory.propose", json!({ "taskId": "t1" })),
            ("browser.run", json!({ "taskId": "t1", "request": { "op": "snapshot" } })),
            ("forge.run", json!({ "taskId": "t1", "tool": "git_pr_list" })),
            ("gemini.consult", json!({ "taskId": "t1" })),
            ("user.ask", json!({ "taskId": "t1", "question": "?" })),
            ("mcp.cancel", json!({ "callId": "c" })),
            ("app.status", json!({})),
            ("agent.list", json!({})),
        ] {
            decide(comando, args.clone(), tarefa("t1"), &[]).unwrap_or_else(|e| panic!("o fluxo da Frota `{comando}` quebrou: {e}"));
        }
    }

    #[test]
    fn a_pessoa_num_terminal_proprio_continua_com_a_cli_toda_menos_o_que_e_so_da_tela() {
        let mut recusados = Vec::new();
        for (metodo, classe) in authz::METHODS {
            let args = json!({ "tab": "aba-da-pessoa", "thread": "t", "mission": "m", "name": "x" });
            let saida = decide(metodo, args, fora(), &[]);
            match (classe, saida) {
                (Class::Person(_) | Class::PersonOrScope(_), Ok(_)) => panic!("{metodo} deixou a pessoa fora passar por cima da tela"),
                (Class::Person(_) | Class::PersonOrScope(_), Err(_)) => {}
                (_, Err(erro)) => recusados.push(format!("{metodo}: {erro}")),
                (_, Ok(_)) => {}
            }
        }
        // Os únicos recusados à pessoa fora (além da tela) são os que só existem a partir de um agente identificado:
        // o handler já exigia o `ADE_TAB_ID` deles. Nenhum método de aba, conversa, missão, frota ou catálogo.
        for linha in &recusados {
            let metodo = linha.split(':').next().unwrap();
            assert!(matches!(authz::class_of(metodo), Some(Class::Scope(Target::Caller | Target::Task))), "a pessoa fora perdeu acesso a {linha}");
        }
    }

    #[test]
    fn o_argumento_que_a_tabela_le_e_o_que_o_handler_usa() {
        let tabs = include_str!("commands/tabs.rs");
        assert!(tabs.contains("arg_str(args, \"tab\")"), "tab.* não lê `tab`");
        let conversas = include_str!("commands/conversas.rs");
        assert!(conversas.contains("arg_str(args, \"thread\")"), "chat.* não lê `thread`");
        let missoes = include_str!("commands/missions.rs");
        assert!(missoes.contains("arg_str(args, \"mission\")"), "mission.* não lê `mission`");
    }

    #[test]
    fn uma_conversa_filha_so_nasce_sob_quem_a_abre() {
        let nova = |args: Value, quem| decide("chat.new", args, quem, &[]);
        assert!(nova(json!({ "parent_ref": "thread:eu" }), aba("thread:eu")).is_ok());
        assert!(nova(json!({ "parent_ref": "tab:m1" }), aba("m1")).is_ok());
        assert!(nova(json!({ "parent_ref": "thread:outra" }), aba("m1")).is_err(), "injetaria a entrega no pai alheio");
        assert!(nova(json!({ "parent_ref": "tab:lead" }), aba("m1")).is_err());
        assert!(nova(json!({ "parent_ref": "thread:qualquer" }), fora()).is_ok());
    }

    #[test]
    fn a_skill_e_o_usage_dizem_o_alcance_por_metodo() {
        let skill = include_str!("../../../skills/ags-orchestrator/SKILL.md");
        for frase in ["every command that acts on another session's resource", "`mission create|run|start`", "`--close-current`", "run `ags` from your own shell"] {
            assert!(skill.contains(frase), "a skill não diz: {frase}");
        }
        let cli = include_str!("../bin/cli.rs");
        assert!(cli.contains("Autorização por método:") && cli.contains("`mission create|run|start`, `worktrees prune`"), "o USAGE não diz o alcance por método");
        let docs = include_str!("../../../docs/decisoes/HOST_REMOTO.md");
        assert!(docs.contains("F-09 (completo)") && docs.contains("Anexo A: inventário dos 221 métodos e a classe de cada um"));
    }

    #[test]
    fn a_conversa_aberta_por_um_agente_fica_registrada_para_ele_continuar() {
        let conversas = include_str!("commands/conversas.rs");
        let inicio = conversas.find("pub(super) fn chat_new(").expect("chat_new mudou de forma");
        let corpo = &conversas[inicio..inicio + conversas[inicio..].find("\n}\n").unwrap()];
        assert!(corpo.matches("remember_opener(args, &row.id)").count() == 2, "chat new não registra quem abriu a conversa nos dois caminhos: o agente não conseguiria dar `chat wait`");
        assert!(conversas.contains("crate::ipc::guard::record_opened("), "remember_opener não grava em guard::record_opened");
    }
}
