//! Testes do contrato de capabilities. Sem relógio e sem processo: só a tabela, o código e o doc.

use std::path::{Path, PathBuf};

use crate::conversa::api::{Engine, MidTurnBehavior};

use super::capability::{Capability, Claim, Proof, Scope, Support, Surface};
use super::matrix::{find, matrix};

const DOC: &str = include_str!("../../../docs/ade-ags/HARNESS_CONTRATO.md");

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
fn todo_provider_cobre_as_18_capabilities_na_ordem_do_enum() {
    assert_eq!(Capability::ALL.len(), 18);
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
    assert_eq!(ids.len(), 18);
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
    for (key, claim) in every_claim() {
        assert_ne!(claim.proof, Proof::RealCapture, "{key}: o repositório não tem captura real de nenhum provider");
    }
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
    assert_eq!(steer.support, Support::Unknown);
    assert!(steer.missing.contains("captura real"));
    assert!(!steer.promises(), "a UI não pode prometer o que o ADE não observa");
}

fn engine_of(provider: &str) -> Engine {
    // O id real é `local-acp-<uuid>` (`local_acp::is_local_acp_id`).
    let id = if provider == "local-acp" { "local-acp-00000000-0000-4000-8000-000000000000" } else { provider };
    Engine::of(id).unwrap_or_else(|| panic!("{provider}: sem motor de conversa"))
}

#[test]
fn a_matriz_do_chat_concorda_com_o_contrato_declarado_do_motor() {
    for column in matrix().iter().filter(|column| column.surface == Surface::Chat) {
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
    // `Scope::Model` só faz sentido onde o modelo muda a resposta: compactar e uso.
    for (key, claim) in every_claim() {
        if claim.scope == Scope::Model {
            assert!(key.ends_with("/compact") || key.ends_with("/usage"), "{key}: escopo de modelo fora de compact e usage");
        }
    }
}
