//! Testes do contrato de capabilities. Sem relógio e sem processo: só a tabela, o código e o doc.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::conversa::api::{Engine, MidTurnBehavior};

use super::capability::{Capability, Claim, Proof, Scope, Support, Surface};
use super::matrix::{find, matrix, supports};

const DOC: &str = include_str!("../../../docs/ade-ags/HARNESS_CONTRATO.md");
const PROVIDER_COMPARISON_BASELINE: &str = include_str!("provider_comparisons.baseline.json");

const PROVIDER_IDS: [&str; 8] = ["claude-code", "codex", "opencode", "antigravity", "cursor", "gemini-cli", "kimi-code", "hermes"];

fn capability_marker(source: &str) -> bool {
    let source = source.to_lowercase();
    [
        "capabilit", "supports_", "unsupported", "steer", "interrupt",
        "compact", "goal", "approval", "resume", "question", "access_modes", "permission_mode",
        "read_only", "child_stop", "child_spawn", "child_result", "tool_events", "turn_completion",
        "event_source", "ags_mcp",
    ]
    .iter()
    .any(|marker| source.contains(marker))
        || ["capability::plan", "supports_plan", "plan_supported", "plansupported", "planavailability", "planproviders", "plan_mode", "plan mode"]
            .iter()
            .any(|marker| source.contains(marker))
}

fn provider_list_declaration(lines: &[&str], receiver: &str, before: usize) -> Option<String> {
    for (index, line) in lines.iter().enumerate().take(before).rev() {
        if !line.contains(receiver)
            || !["const ", "let ", "var "].iter().any(|keyword| line.contains(keyword))
        {
            continue;
        }
        let mut declaration = (*line).to_string();
        for nested in lines.iter().skip(index + 1).take(20) {
            if declaration.contains('[') && declaration.contains(']') { break; }
            declaration.push(' ');
            declaration.push_str(nested);
        }
        let names_provider = PROVIDER_IDS.iter().any(|provider| declaration.contains(&format!("\"{provider}\"")) || declaration.contains(&format!("'{provider}'")));
        if names_provider && declaration.contains('[') && declaration.contains(']') {
            return Some(declaration);
        }
    }
    None
}

fn provider_capability_lines(source: &str, _relative: &str) -> Vec<String> {
    let lines: Vec<&str> = source.lines().map(str::trim).collect();
    let mut found = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let match_subject = ["match agent_id", "match agentId", "match provider", "match agent"]
            .iter()
            .any(|subject| line.contains(subject));
        let switch_subject = (line.starts_with("switch ") || line.starts_with("switch("))
            && ["agent_id", "agentId", "provider", "agent"].iter().any(|name| line.contains(name));
        if (match_subject || switch_subject) && line.contains('{') {
            let header_has_capability = capability_marker(line);
            let mut depth = 0_i32;
            let mut end = index;
            for (offset, nested) in lines.iter().enumerate().skip(index) {
                for ch in nested.chars() {
                    if ch == '{' { depth += 1; }
                    if ch == '}' { depth -= 1; }
                }
                end = offset;
                if depth == 0 { break; }
            }
            let arms = &lines[index..=end];
            if match_subject {
                for (arm_index, arm) in arms.iter().enumerate().filter(|(_, arm)| arm.contains("=>")) {
                    let next_arm = arms.iter().enumerate().skip(arm_index + 1)
                        .find(|(_, candidate)| candidate.contains("=>"))
                        .map(|(next, _)| next)
                        .unwrap_or(arms.len());
                    let arm_body = arms[arm_index..next_arm].join(" ");
                    let names_provider = PROVIDER_IDS.iter().any(|provider| {
                        arm.contains(&format!("\"{provider}\"")) || arm.contains(&format!("'{provider}'"))
                    });
                    if names_provider && (header_has_capability || capability_marker(&arm_body)) {
                        found.push((*arm).to_string());
                    }
                }
            } else {
                for (arm_index, arm) in arms.iter().enumerate().filter(|(_, arm)| arm.trim_start().starts_with("case ")) {
                    let next_arm = arms.iter().enumerate().skip(arm_index + 1)
                        .find(|(_, candidate)| candidate.trim_start().starts_with("case ") || candidate.trim_start().starts_with("default:"))
                        .map(|(next, _)| next)
                        .unwrap_or(arms.len());
                    let arm_body = arms[arm_index..next_arm].join(" ");
                    let names_provider = PROVIDER_IDS.iter().any(|provider| {
                        arm.contains(&format!("\"{provider}\"")) || arm.contains(&format!("'{provider}'"))
                    });
                    if names_provider && (header_has_capability || capability_marker(&arm_body)) {
                        found.push((*arm).to_string());
                    }
                }
            }
            continue;
        }
        let includes_list = line.find(".includes(").or_else(|| line.find(".has(")).or_else(|| line.find(".contains(")).and_then(|at| {
            let receiver = line[..at].trim().rsplit(|ch: char| !(ch.is_alphanumeric() || ch == '_')).next()?;
            provider_list_declaration(&lines, receiver, index)
        });
        let provider_name = PROVIDER_IDS.iter().any(|provider| line.contains(&format!("\"{provider}\"")) || line.contains(&format!("'{provider}'")))
            || includes_list.is_some();
        let subject = ["agent_id", "agentId", "provider", "agent"].iter().any(|name| line.contains(name));
        if !provider_name || !subject { continue; }
        let indirect = line.contains("matches!(") || line.contains(".includes(") || line.contains(".has(") || line.contains(".contains(") || line.contains("=>");
        let mut contextual = line.to_string();
        if let Some(declaration) = includes_list {
            contextual = format!("{declaration} {contextual}");
        }
        if line.contains("matches!(") || line.contains(".includes(") || line.contains(".has(") || line.contains(".contains(") {
            contextual = format!("{} {contextual}", lines[index.saturating_sub(2)..index].join(" "));
        }
        let conditional = line.starts_with("if ") || line.starts_with("if(") || line.starts_with("else if ") || line.starts_with("else if(");
        let compares_provider = line.contains("==") || line.contains("!=");
        if conditional && (compares_provider || line.contains("matches!(") || line.contains(".includes(") || line.contains(".has(") || line.contains(".contains(")) {
            let mut depth = 0_i32;
            let mut opened = false;
            for nested in lines.iter().skip(index).take(40) {
                for ch in nested.chars() {
                    if ch == '{' { depth += 1; opened = true; }
                    if ch == '}' { depth -= 1; }
                }
                contextual.push_str(nested);
                if opened && depth <= 0 { break; }
            }
        }
        let capability_context = if conditional || indirect {
            contextual
        } else if let Some(equal_at) = line.find("==").or_else(|| line.find("!=")) {
            let clause_start = line[..equal_at].rfind(|ch| ch == ',' || ch == ';').map_or(0, |offset| offset + 1);
            line[clause_start..].to_string()
        } else {
            line.to_string()
        };
        if capability_marker(&capability_context) && (indirect || compares_provider) {
            found.push((*line).to_string());
        }
    }
    found
}

fn production_source(source: &str) -> &str {
    source.split_once("#[cfg(test)]").map_or(source, |(production, _)| production)
}

fn source_provider_comparisons(path: &Path, root: &Path, found: &mut BTreeMap<String, BTreeMap<String, usize>>) {
    let entries = std::fs::read_dir(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    for entry in entries {
        let entry = entry.unwrap();
        let file = entry.path();
        if file.is_dir() {
            source_provider_comparisons(&file, root, found);
            continue;
        }
        let relative = file.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if relative == "src-tauri/src/agents/adapter.rs"
            || relative == "src-tauri/src/agents/registry.rs"
            || relative == "src/features/chat/harnessCapabilities.ts"
        {
            continue;
        }
        if relative.contains("/tests/") || relative.contains("/__tests__/") || relative == "src-tauri/src/agents/contract.rs" || file.file_name().and_then(|name| name.to_str()).is_some_and(|name| name == "test.rs" || name.ends_with("_test.rs") || name.ends_with(".test.ts") || name.ends_with(".test.tsx")) {
            continue;
        }
        let rust = file.extension().and_then(|ext| ext.to_str()) == Some("rs") && relative.starts_with("src-tauri/src/");
        let typescript = matches!(file.extension().and_then(|ext| ext.to_str()), Some("ts" | "tsx")) && relative.starts_with("src/");
        if !rust && !typescript {
            continue;
        }
        let source = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
        let source = if rust { production_source(&source) } else { &source };
        for line in provider_capability_lines(source, &relative) {
            *found.entry(relative.clone()).or_default().entry(line).or_default() += 1;
        }
    }
}

#[test]
fn comparacoes_de_provider_nao_crescem_fora_do_adapter_e_registro() {
    let root = repo_root();
    let mut actual = BTreeMap::new();
    source_provider_comparisons(&root.join("src-tauri/src"), &root, &mut actual);
    source_provider_comparisons(&root.join("src"), &root, &mut actual);
    let baseline: BTreeMap<String, Vec<String>> = serde_json::from_str(PROVIDER_COMPARISON_BASELINE).unwrap();
    let mut expected = BTreeMap::new();
    for (file, lines) in baseline {
        for line in lines {
            *expected.entry(file.clone()).or_insert_with(BTreeMap::new).entry(line).or_insert(0) += 1;
        }
    }
    assert_eq!(actual, expected, "comparações por provider que decidem capability fora do adapter/registro mudaram; atualize o baseline somente para pendências classificadas");
}

#[test]
fn guarda_encontra_padroes_indiretos_de_capability_sem_contar_identidade() {
    let source = r#"
        let plan_supported = matches!(provider, "claude-code" | "codex");
        const compactProviders = ["claude-code", "codex"].includes(agentId);
        const PLAN_CAPABILITY_PROVIDERS = ["claude-code", "codex"];
        if (PLAN_CAPABILITY_PROVIDERS.includes(agentId)) { enablePlan(); }
        const PLAN_CAPABILITY_SET = new Set(["claude-code", "codex"]);
        if (PLAN_CAPABILITY_SET.has(agentId)) { enablePlan(); }
        const PLAN_CAPABILITY_LIST: &[&str] = &["claude-code", "codex"];
        if PLAN_CAPABILITY_LIST.contains(&agent_id) { enablePlan(); }
        match agent_id {
          "opencode" => supports_compact(),
          _ => false
        }
        if agent_id == "antigravity" { return supports_compact(); }
        if agentId !== "opencode" { planSupported = false; }
        let parser = match provider { "codex" => "json", _ => "text" };
        let supports_goal = match provider {
          "hermes" => true,
          _ => false,
        };
        switch (provider) {
          case "cursor": supports_compact(); break;
          default: break;
        }
    "#;
    let found = provider_capability_lines(source, "src/features/example.ts");
    assert_eq!(found.len(), 10);
    assert!(found[0].contains("matches!("));
    assert!(found[1].contains("includes("));
    assert!(found[2].contains("PLAN_CAPABILITY_PROVIDERS"));
    assert!(found[3].contains("PLAN_CAPABILITY_SET"));
    assert!(found[4].contains("PLAN_CAPABILITY_LIST"));
    assert!(found[5].contains("supports_compact"));
    assert!(found[6].contains("antigravity"));
    assert!(found[7].contains("opencode"));
    assert!(found[8].contains("hermes"));
    assert!(found[9].contains("cursor"));
    assert!(provider_capability_lines(
        r#"match agent_id { "codex" => parse_codex_json(), _ => parse_text() }"#,
        "src-tauri/src/canal/mod.rs",
    ).is_empty());
    assert!(provider_capability_lines(
        r#"if agent_id == "codex" { parse_codex_json() }"#,
        "src-tauri/src/conversa/parser.rs",
    ).is_empty());
    assert!(provider_capability_lines(
        r#"if account.agentId === "claude-code" { account.plan = usage.plan; }"#,
        "src/features/accounts/usage.ts",
    ).is_empty());
    assert!(provider_capability_lines(
        r#"const providers = ["codex"]; if (providers.includes(agentId)) { choose_binary(); }"#,
        "src/features/chat/identity.ts",
    ).is_empty());
    assert!(provider_capability_lines(
        r#"switch (provider) { case "codex": parse_codex_json(); break; }"#,
        "src-tauri/src/canal/parser.rs",
    ).is_empty());
    assert!(provider_capability_lines(
        production_source(r#"fn parse() {} #[cfg(test)] mod tests { if agent_id == "codex" { supports_plan(); } }"#),
        "src-tauri/src/runs/example.rs",
    ).is_empty());
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn every_claim() -> Vec<(String, Claim)> {
    let mut claims = Vec::new();
    for column in matrix() {
        for cell in &column.cells {
            claims.push((format!("{}/{}/{}", column.surface.id(), column.provider, cell.capability.id()), cell.claim));
        }
        claims.push((format!("{}/{}/ags_mcp", column.surface.id(), column.provider), column.ags_mcp));
        claims.push((format!("{}/{}/fork", column.surface.id(), column.provider), column.fork));
        claims.push((format!("{}/{}/comandos", column.surface.id(), column.provider), column.comandos));
    }
    claims
}

#[test]
fn a_matriz_tem_as_22_colunas_esperadas() {
    let expected: Vec<(Surface, &str)> = [
        (Surface::Chat, ["claude-code", "codex", "opencode", "antigravity", "cursor", "local-acp"].as_slice()),
        (
            Surface::Fleet,
            ["claude-code", "gemini-cli", "codex", "opencode", "kimi-code", "hermes", "antigravity", "cursor"].as_slice(),
        ),
        (
            Surface::Tui,
            ["claude-code", "gemini-cli", "codex", "opencode", "kimi-code", "hermes", "antigravity", "cursor"].as_slice(),
        ),
    ]
    .into_iter()
    .flat_map(|(surface, providers)| providers.iter().map(move |provider| (surface, *provider)))
    .collect();
    let actual: Vec<(Surface, &str)> = matrix().iter().map(|column| (column.surface, column.provider)).collect();
    assert_eq!(actual, expected);
}

#[test]
fn todo_provider_cobre_as_20_capabilities_na_ordem_do_enum() {
    assert_eq!(Capability::ALL.len(), 20);
    for column in matrix() {
        let listed: Vec<Capability> = column.cells.iter().map(|cell| cell.capability).collect();
        assert_eq!(listed, Capability::ALL, "{}/{}", column.surface.id(), column.provider);
        for (index, capability) in Capability::ALL.iter().enumerate() {
            assert_eq!(*capability as usize, index, "o discriminante de {capability:?} deixou de ser a posição");
        }
    }
}

#[test]
fn os_ids_das_capabilities_sao_unicos() {
    let mut ids: Vec<&str> = Capability::ALL.iter().map(|capability| capability.id()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 20);
}

#[test]
fn supports_consulta_supported_unknown_e_unsupported_na_matriz() {
    assert_eq!(supports("claude-code", Surface::Chat, Capability::Steer), Some(Support::Supported));
    assert_eq!(supports("opencode", Surface::Chat, Capability::Steer), Some(Support::Unsupported));
    assert_eq!(supports("claude-code", Surface::Chat, Capability::Compact), Some(Support::Unknown));
    assert_eq!(supports("inexistente", Surface::Chat, Capability::Steer), None);
    assert!(crate::conversa::api::unsupported_capability_error("opencode", Capability::Goal)
        .unwrap()
        .contains("Unsupported"));
    assert!(crate::conversa::api::unsupported_capability_error("opencode", Capability::Compact)
        .unwrap()
        .contains("compact"));
    assert!(crate::conversa::api::unsupported_capability_error("local-acp-00000000-0000-4000-8000-000000000000", Capability::Goal)
        .unwrap()
        .contains("local-acp-00000000-0000-4000-8000-000000000000"));
    assert_eq!(crate::conversa::api::unsupported_capability_error("claude-code", Capability::Compact), None);
    let fleet_error = crate::harness::matrix::unsupported_capability_error("hermes", Surface::Fleet, Capability::Start).unwrap();
    assert!(fleet_error.contains("start") && fleet_error.contains("hermes") && fleet_error.contains("Unsupported"));
}

#[test]
fn frota_recusa_start_unsupported_antes_de_tentar_lancar() {
    let error = crate::runs::ensure_headless("hermes").unwrap_err();
    assert!(error.contains("start") && error.contains("hermes") && error.contains("Unsupported"), "{error}");
    assert!(crate::runs::ensure_headless("codex").is_ok());
}

#[test]
fn plan_e_uma_capability_com_prova_em_todas_as_superficies() {
    assert_eq!(Capability::ALL.len(), 20);
    assert_eq!(supports("claude-code", Surface::Chat, Capability::Plan), Some(Support::Supported));
    assert_eq!(supports("codex", Surface::Chat, Capability::Plan), Some(Support::Unsupported));
    assert_eq!(supports("claude-code", Surface::Fleet, Capability::Plan), Some(Support::Unsupported));
    assert_eq!(supports("claude-code", Surface::Tui, Capability::Plan), Some(Support::Supported));
    assert_eq!(supports("codex", Surface::Tui, Capability::Plan), Some(Support::Unsupported));

    for column in matrix() {
        let claim = column.claim(Capability::Plan);
        assert!(!claim.evidence.is_empty(), "{}/{}/plan sem evidência", column.surface.id(), column.provider);
        assert!(claim.proof > Proof::None, "{}/{}/plan sem prova", column.surface.id(), column.provider);
        assert_ne!(claim.proof, Proof::RealCapture, "{}/{}/plan não tem captura real", column.surface.id(), column.provider);
    }
}

#[test]
fn compact_e_goal_desconhecidos_na_tui_nao_sao_prometidos() {
    for provider in ["claude-code", "codex"] {
        assert_eq!(supports(provider, Surface::Tui, Capability::Compact), Some(Support::Unknown), "{provider}/compact");
    }
    assert_eq!(supports("claude-code", Surface::Tui, Capability::Goal), Some(Support::Unknown));
}

#[test]
fn comando_tauri_expoe_a_matriz_sem_duplicar_o_catalogo() {
    let exposed = super::commands::harness_capability_matrix();
    assert_eq!(exposed.as_slice(), matrix());
    assert!(serde_json::to_value(exposed).is_ok());
}

#[test]
fn todo_supported_tem_evidencia_e_prova() {
    for (key, claim) in every_claim() {
        if claim.support == Support::Supported {
            assert!(!claim.evidence.is_empty(), "{key}: Supported sem evidência");
            assert!(claim.proof > Proof::None, "{key}: Supported sem prova");
            assert!(claim.missing.is_empty(), "{key}: Supported não tem o que provar");
            assert!(!claim.note.trim().is_empty(), "{key}: Supported sem observação");
        }
    }
}

#[test]
fn todo_unknown_diz_o_que_falta_provar() {
    let mut unknowns = 0;
    for (key, claim) in every_claim() {
        if claim.support == Support::Unknown {
            unknowns += 1;
            assert!(claim.missing.trim().len() >= 20, "{key}: Unknown sem dizer o que falta provar");
            assert!(claim.proof < Proof::RealCapture, "{key}: Unknown com captura real não é Unknown");
        } else {
            assert!(claim.missing.is_empty(), "{key}: só Unknown tem `missing`");
        }
    }
    assert!(unknowns > 0, "a matriz atual tem Unknown; se zerou, atualize o doc e este teste");
}

#[test]
fn todo_unsupported_diz_o_motivo() {
    for (key, claim) in every_claim() {
        if claim.support == Support::Unsupported {
            assert!(claim.note.trim().len() >= 8, "{key}: Unsupported sem motivo");
        }
    }
}

#[test]
fn nenhuma_celula_alega_captura_real_enquanto_nao_houver_uma() {
    let root = repo_root();
    let mut reais = 0;
    for (key, claim) in every_claim() {
        if claim.proof != Proof::RealCapture {
            continue;
        }
        reais += 1;
        let mut achou = false;
        for citation in claim.evidence {
            let (path, _) = parse_citation(citation);
            if !path.contains("conversa/fixtures/protocolo/") || !path.ends_with(".json") || path.ends_with(".oracle.json") {
                continue;
            }
            let text = std::fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{key}: {citation}: {error}"));
            let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|error| panic!("{key}: {citation}: {error}"));
            assert_eq!(value["origin"]["kind"].as_str(), Some("recorded"), "{key}: {path} não é recorded");
            achou = true;
        }
        assert!(achou, "{key}: prova recorded sem fixture que exista e seja recorded");
    }
    assert!(reais > 0, "há captura recorded; a regra não pode ficar vazia");
}

fn parse_citation(citation: &str) -> (&str, Option<(usize, usize)>) {
    match citation.rsplit_once(':') {
        Some((path, lines)) if lines.chars().all(|c| c.is_ascii_digit() || c == '-') && !lines.is_empty() => {
            let (start, end) = lines.split_once('-').unwrap_or((lines, lines));
            let start: usize = start.parse().expect("linha inicial");
            let end: usize = end.parse().expect("linha final");
            (path, Some((start, end)))
        }
        _ => (citation, None),
    }
}

#[test]
fn as_citacoes_apontam_para_arquivos_e_linhas_que_existem() {
    let root = repo_root();
    for (key, claim) in every_claim() {
        for citation in claim.evidence {
            let (path, lines) = parse_citation(citation);
            let file = root.join(path);
            let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{key}: {citation}: {error}"));
            if let Some((start, end)) = lines {
                let total = text.lines().count();
                assert!(start >= 1 && start <= end, "{key}: {citation}: intervalo inválido");
                assert!(end <= total, "{key}: {citation}: o arquivo tem só {total} linhas");
            }
        }
    }
}

#[test]
fn o_steer_do_claude_fica_unknown_ate_haver_captura_real() {
    let claude = find(Surface::Chat, "claude-code").expect("coluna do Claude");
    let steer = claude.claim(Capability::Steer);
    assert_eq!(steer.support, Support::Supported);
    assert_eq!(steer.proof, Proof::RealCapture);
    assert_eq!(
        steer.note,
        "em turno com ferramenta a mensagem entra depois da fronteira da ferramenta; em turno sem ferramenta a resposta corrente não muda e a mensagem vira um novo turno logo depois do `result`."
    );
    assert!(steer.promises());
}

fn engine_of(provider: &str) -> Engine {
    // O id real é `local-acp-<uuid>` (`local_acp::is_local_acp_id`).
    let id = if provider == "local-acp" { "local-acp-00000000-0000-4000-8000-000000000000" } else { provider };
    Engine::of(id).unwrap_or_else(|| panic!("{provider}: sem motor de conversa"))
}

#[test]
fn a_matriz_do_chat_concorda_com_o_contrato_declarado_do_motor() {
    for column in matrix().iter().filter(|column| column.surface == Surface::Chat && column.provider != "local-acp") {
        let declared = engine_of(column.provider).capabilities();
        let steer = column.claim(Capability::Steer).support;
        match declared.mid_turn {
            MidTurnBehavior::Steer => assert_ne!(steer, Support::Unsupported, "{}: declara steer", column.provider),
            MidTurnBehavior::Interrupt => assert_eq!(steer, Support::Unsupported, "{}: declara interrupt", column.provider),
        }
        let compact = column.claim(Capability::Compact).support;
        assert_eq!(declared.context_compaction, compact != Support::Unsupported, "{}: compact", column.provider);
        let goal = column.claim(Capability::Goal).support;
        assert_eq!(declared.persistent_goal, goal != Support::Unsupported, "{}: goal", column.provider);
        assert_eq!(declared.plan, column.claim(Capability::Plan).support != Support::Unsupported, "{}: plan", column.provider);
        assert_eq!(declared.session_fork, column.fork.promises(), "{}: fork", column.provider);
    }
}

#[test]
fn o_fork_da_pergunta_lateral_so_existe_no_chat_do_claude_e_do_codex() {
    for column in matrix() {
        let esperado = column.surface == Surface::Chat && matches!(column.provider, "claude-code" | "codex");
        assert_eq!(column.fork.promises(), esperado, "{}/{}: fork", column.surface.id(), column.provider);
    }
}

#[test]
fn a_contagem_do_doc_concorda_com_a_matriz() {
    let start = DOC.find("<!-- contagem-matriz:inicio -->").expect("marca de início da contagem no doc");
    let end = DOC.find("<!-- contagem-matriz:fim -->").expect("marca de fim da contagem no doc");
    let mut seen = 0;
    for line in DOC[start..end].lines() {
        let cells: Vec<&str> = line.trim().trim_matches('|').split('|').map(str::trim).collect();
        let [surface, provider, supported, unknown, unsupported, ags_mcp] = cells.as_slice() else { continue };
        let Some(surface) = [Surface::Chat, Surface::Fleet, Surface::Tui]
            .into_iter()
            .find(|candidate| candidate.id().eq_ignore_ascii_case(surface))
        else {
            continue;
        };
        let column = find(surface, provider).unwrap_or_else(|| panic!("o doc lista {provider}, que não está na matriz"));
        let counts = column.counts();
        assert_eq!(
            (counts.supported.to_string(), counts.unknown.to_string(), counts.unsupported.to_string()),
            (supported.to_string(), unknown.to_string(), unsupported.to_string()),
            "{}/{provider}: o doc e a matriz divergem",
            surface.id()
        );
        let ags = match column.ags_mcp.support {
            Support::Supported => "Supported",
            Support::Unknown => "Unknown",
            Support::Unsupported => "Unsupported",
        };
        assert_eq!(*ags_mcp, ags, "{}/{provider}: ags_mcp", surface.id());
        seen += 1;
    }
    assert_eq!(seen, matrix().len(), "o doc precisa listar as {} colunas", matrix().len());
}

#[test]
fn cada_provider_aparece_uma_vez_por_superficie() {
    let mut keys: Vec<(Surface, &str)> = matrix().iter().map(|column| (column.surface, column.provider)).collect();
    let total = keys.len();
    keys.sort_by(|a, b| (a.0.id(), a.1).cmp(&(b.0.id(), b.1)));
    keys.dedup();
    assert_eq!(keys.len(), total);
}

#[test]
fn escopos_de_instancia_so_nas_capabilities_que_o_adapter_decide_sozinho() {
    // `Scope::Model` só faz sentido quando o modelo muda a resposta: compactar, uso ou Fast.
    for (key, claim) in every_claim() {
        if claim.scope == Scope::Model {
            assert!(key.ends_with("/compact") || key.ends_with("/usage") || key.ends_with("/fast_mode"), "{key}: escopo de modelo sem variação por modelo");
        }
    }
}

// ── Fase 1: identidade durável (`harness_run`, `harness_node`) ──────────────────────────────

mod fase1 {
    use rusqlite::Connection;

    use crate::conversa::store::{self as chat, Tuning};
    use crate::harness::state::{EndReason, NodeState, from_chat_run, from_fleet_run, from_task};
    use crate::harness::store as harness;
    use crate::runs::store::{self as fleet, NewTask, SWEPT_RUNNING_ERROR};

    fn db() -> Connection {
        crate::database::test_db()
    }

    fn tuning() -> Tuning {
        Tuning { model: None, effort: None, access: "ask".into() }
    }

    fn thread(conn: &Connection, id: &str) {
        chat::insert_thread(conn, id, "codex", "/p", "T", &tuning(), None, 1).unwrap();
    }

    fn child(conn: &Connection, id: &str, parent: &str) {
        let parent_ref = format!("thread:{parent}");
        chat::insert_thread_with_parent(conn, id, "codex", "/p", "T", &tuning(), None, Some(&parent_ref), 2).unwrap();
    }

    fn turn(conn: &Connection, thread: &str, id: &str, status: &str) {
        chat::upsert_run(conn, thread, id, status, Some(1), None, None).unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
    }

    fn fleet_run(conn: &Connection, source: Option<&str>) -> String {
        conn.execute_batch("INSERT OR IGNORE INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)").unwrap();
        let run = fleet::create_run(conn, "w1", "objetivo", "/p").unwrap();
        if let Some(thread) = source {
            fleet::set_run_source_thread(conn, &run.id, thread).unwrap();
        }
        run.id
    }

    fn fleet_task(conn: &Connection, run_id: &str, key: &str) -> String {
        fleet::create_task(
            conn,
            &NewTask { run_id, title: key, prompt: "p", agent_id: "claude-code", cwd: "/p", plan_key: Some(key), ..Default::default() },
        )
        .unwrap()
        .id
    }

    /// Teste 1.
    #[test]
    fn a_migracao_do_harness_roda_duas_vezes_sem_perder_linhas() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        child(&conn, "c", "r");
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (1, 2));
        harness::migrate(&conn).unwrap();
        chat::migrate(&conn).unwrap();
        crate::database::migrate_for_tests(&conn).unwrap();
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (1, 2), "migrar de novo não apaga nada");
    }

    #[test]
    fn ligar_de_novo_o_mesmo_registro_nativo_devolve_o_mesmo_no() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        let first = harness::link_child_chat(&conn, "r", "t1", "c", 5).unwrap();
        assert_eq!(harness::link_child_chat(&conn, "r", "t1", "c", 6).unwrap(), first);
        let run_id = fleet_run(&conn, Some("r"));
        let node = harness::link_fleet_run(&conn, "r", "t1", &run_id, 7).unwrap();
        assert_eq!(harness::link_fleet_run(&conn, "r", "t1", &run_id, 8).unwrap(), node);
        let task = fleet_task(&conn, &run_id, "a");
        let task_node = harness::link_fleet_task(&conn, &run_id, &task, None, 9).unwrap().unwrap();
        assert_eq!(harness::link_fleet_task(&conn, &run_id, &task, None, 10).unwrap(), Some(task_node));
        // root + filho de chat + run + tarefa, num único run do harness.
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (1, 4));
    }

    #[test]
    fn a_tarefa_cuja_pai_tem_no_fica_sob_a_pai_e_a_sem_run_ligado_nao_vira_no() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        let run_id = fleet_run(&conn, Some("r"));
        let lead = fleet_task(&conn, &run_id, "lead");
        let sub = fleet_task(&conn, &run_id, "sub");
        // Sem nó para o run da Frota: tarefa não cria run nem nó.
        assert_eq!(harness::link_fleet_task(&conn, &run_id, &lead, None, 1).unwrap(), None);
        assert_eq!(count(&conn, "harness_node"), 0);
        harness::link_fleet_run(&conn, "r", "t1", &run_id, 2).unwrap();
        let lead_node = harness::link_fleet_task(&conn, &run_id, &lead, None, 3).unwrap().unwrap();
        harness::link_fleet_task(&conn, &run_id, &sub, Some(&lead), 4).unwrap();
        let parent: String = conn
            .query_row("SELECT parent_id FROM harness_node WHERE legacy_ref = ?1", [format!("task:{sub}")], |row| row.get(0))
            .unwrap();
        assert_eq!(parent, lead_node);
    }

    #[test]
    fn o_id_do_turno_nao_cruza_conversas() {
        let conn = db();
        thread(&conn, "a");
        thread(&conn, "b");
        // O mesmo `turn_id` em duas conversas: duas identidades, nunca uma só.
        turn(&conn, "a", "t1", "inProgress");
        turn(&conn, "b", "t1", "inProgress");
        let a = harness::ensure_run(&conn, "a", "t1", 1).unwrap();
        let b = harness::ensure_run(&conn, "b", "t1", 1).unwrap();
        assert_ne!(a.run_id, b.run_id);
        assert_ne!(a.root_node_id, b.root_node_id);
        assert_eq!(harness::ensure_run(&conn, "a", "t1", 9).unwrap(), a);
    }

    /// Teste 8: só as linhas `harness_*` (e as dependentes da conversa) saem; a Frota fica.
    #[test]
    fn apagar_a_conversa_remove_so_as_linhas_do_harness_e_a_frota_fica() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        child(&conn, "c", "r");
        let run_id = fleet_run(&conn, Some("r"));
        harness::link_fleet_run(&conn, "r", "t1", &run_id, 3).unwrap();
        let task = fleet_task(&conn, &run_id, "a");
        harness::link_fleet_task(&conn, &run_id, &task, None, 4).unwrap();
        assert_eq!(count(&conn, "harness_node"), 4);
        conn.execute("DELETE FROM chat_thread WHERE id = 'r'", []).unwrap();
        assert_eq!((count(&conn, "harness_run"), count(&conn, "harness_node")), (0, 0));
        assert_eq!((count(&conn, "runs"), count(&conn, "tasks")), (1, 1), "a Frota não é tocada");
        assert_eq!(chat::thread(&conn, "c").unwrap().map(|row| row.id), Some("c".into()), "outra conversa também não");
    }

    /// Ajuste 2: apagar uma conversa lateral filha não pode deixar nó apontando para nada.
    #[test]
    fn apagar_a_conversa_lateral_filha_tira_o_no_dela_e_deixa_o_do_turno() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        child(&conn, "c", "r");
        child(&conn, "d", "r");
        assert_eq!(count(&conn, "harness_node"), 3);
        assert!(chat::delete_side_chat(&conn, "c").unwrap());
        let refs: Vec<String> = conn
            .prepare("SELECT legacy_ref FROM harness_node ORDER BY legacy_ref")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(refs, ["thread:d", "turn:r:t1"]);
        assert_eq!(count(&conn, "harness_run"), 1);
    }

    /// Ajuste 2 (outras rotas): a Frota não tem rota de apagar, mas o CASCADE do workspace apaga run e
    /// tarefas. Os nós saem na mesma operação (o gatilho dispara também nas deleções por CASCADE).
    #[test]
    fn apagar_o_run_ou_a_tarefa_da_frota_tira_os_nos_sem_estourar() {
        let conn = db();
        thread(&conn, "r");
        turn(&conn, "r", "t1", "inProgress");
        let run_a = fleet_run(&conn, Some("r"));
        harness::link_fleet_run(&conn, "r", "t1", &run_a, 3).unwrap();
        let task_a = fleet_task(&conn, &run_a, "a");
        let task_b = fleet_task(&conn, &run_a, "b");
        harness::link_fleet_task(&conn, &run_a, &task_a, None, 4).unwrap();
        harness::link_fleet_task(&conn, &run_a, &task_b, None, 4).unwrap();
        assert_eq!(count(&conn, "harness_node"), 4);
        conn.execute("DELETE FROM tasks WHERE id = ?1", [&task_a]).unwrap();
        assert_eq!(count(&conn, "harness_node"), 3);
        // O workspace apaga o run e as tarefas por CASCADE.
        conn.execute("DELETE FROM workspaces WHERE id = 'w1'", []).unwrap();
        assert_eq!(count(&conn, "runs"), 0);
        let left: Vec<String> = conn
            .prepare("SELECT legacy_ref FROM harness_node")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, ["turn:r:t1"], "só o nó raiz do turno, que não tem origem apagada");
    }

    #[test]
    fn o_estado_do_no_e_derivado_do_nativo() {
        let state = |derived: crate::harness::state::Derived| derived.state;
        assert_eq!(state(from_chat_run("inProgress", false)), NodeState::Running);
        assert_eq!(state(from_chat_run("inProgress", true)), NodeState::Waiting);
        assert_eq!(state(from_chat_run("completed", false)), NodeState::Completed);
        assert_eq!(state(from_chat_run("failed", false)), NodeState::Failed);
        assert_eq!(state(from_chat_run("interrupted", true)), NodeState::Interrupted);
        // Valor desconhecido nunca vira terminal conhecido.
        let unknown = from_chat_run("aborted", false);
        assert_eq!(unknown.state, NodeState::Interrupted);
        assert_eq!(unknown.end_reason, Some(EndReason::UnmappedNativeStatus));
        assert!(unknown.outcome_unknown);

        for (native, expected) in [
            ("pending", NodeState::Pending),
            ("ready", NodeState::Pending),
            ("running", NodeState::Running),
            ("done", NodeState::Completed),
            ("failed", NodeState::Failed),
            ("cancelled", NodeState::Cancelled),
            ("handed_off", NodeState::HandedOff),
            ("skipped", NodeState::Skipped),
        ] {
            assert_eq!(state(from_task(native, None)), expected, "{native}");
        }
        let swept = from_task("failed", Some(SWEPT_RUNNING_ERROR));
        assert_eq!((swept.state, swept.end_reason), (NodeState::Interrupted, Some(EndReason::AppClosed)));
        assert_eq!(from_task("skipped", None).end_reason, Some(EndReason::DependencyFailed));
        assert_eq!(state(from_fleet_run("done")), NodeState::Completed);
        assert!(NodeState::Cancelled.is_terminal() && !NodeState::Waiting.is_terminal());
    }
}

#[test]
fn comandos_do_chat_declara_so_as_fontes_que_existem() {
    // A lista do `/` vem do protocolo (initialize, skills/list, ACP) ou da varredura de pastas; fora do chat não há composer.
    let chat_with = |support: Support| -> Vec<&'static str> {
        matrix().iter().filter(|column| column.surface == Surface::Chat && column.comandos.support == support).map(|column| column.provider).collect()
    };
    assert_eq!(chat_with(Support::Supported), ["claude-code", "codex", "opencode", "antigravity", "cursor", "local-acp"]);
    assert!(chat_with(Support::Unknown).is_empty());
    assert!(
        matrix().iter().filter(|column| column.surface != Surface::Chat).all(|column| column.comandos.support == Support::Unsupported),
        "fora do chat não há composer, então o menu do `/` não existe"
    );
}

#[test]
fn comandos_do_doc_concorda_com_a_matriz() {
    let start = DOC.find("<!-- comandos:inicio -->").expect("marca de início da tabela de comandos no doc");
    let end = DOC.find("<!-- comandos:fim -->").expect("marca de fim da tabela de comandos no doc");
    let mut seen = 0;
    for line in DOC[start..end].lines() {
        let cells: Vec<&str> = line.trim().trim_matches('|').split('|').map(str::trim).collect();
        let [surface, provider, support] = cells.as_slice() else { continue };
        if !surface.eq_ignore_ascii_case("chat") {
            continue;
        }
        let column = find(Surface::Chat, provider).unwrap_or_else(|| panic!("o doc lista {provider}, que não está na matriz"));
        let declared = match column.comandos.support {
            Support::Supported => "Supported",
            Support::Unknown => "Unknown",
            Support::Unsupported => "Unsupported",
        };
        assert_eq!(*support, declared, "chat/{provider}: comandos do doc e da matriz divergem");
        seen += 1;
    }
    assert_eq!(seen, 6, "o doc lista as 6 colunas de chat");
}
