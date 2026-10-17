//! Que tipo de projeto é este, para o `ags test` rodar as suítes que ELE tem.
//!
//! Antes os comandos eram os do próprio ADE-AGS para qualquer repositório (`scripts/babel-parse-check.mjs`,
//! `node_modules/typescript`, `cargo` em `src-tauri`): numa missão num repo Node puro (CredPro) o
//! `ags test affected` falhava, todo arquivo virava "não mapeado" e o plano incluía a suíte Rust de um
//! repo sem Rust. Agora o layout do ADE-AGS é reconhecido como antes (mapeamento fino por módulo, chave
//! de cache por suíte) e os outros repositórios rodam as suítes detectadas, inteiras.

use std::path::Path;

use super::run::TestCommand;

/// O que se sabe do repositório.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Layout {
    /// Este repositório (ou um igual): `src-tauri/Cargo.toml` e `scripts/babel-parse-check.mjs`.
    AdeAgs,
    /// Qualquer outro, com as suítes que foram achadas (pode ser nenhuma).
    Generic(Vec<TestCommand>),
}

impl Layout {
    pub fn is_ade(&self) -> bool {
        matches!(self, Layout::AdeAgs)
    }
}

/// O que a detecção olha, para poder testá-la sem disco.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    pub ade_markers: bool,
    pub cargo_root: bool,
    pub cargo_src_tauri: bool,
    pub tsconfig: bool,
    pub typescript_installed: bool,
    pub vitest_dependency: bool,
    pub vitest_installed: bool,
    /// `scripts.test` do package.json, se não for o placeholder do `npm init`.
    pub npm_test: bool,
    /// Há `test/` ou `tests/` com arquivos `*.test.{js,mjs,cjs}` (o `node --test` acha sozinho).
    pub node_tests: bool,
}

const TSC: &str = "node_modules/typescript/bin/tsc";
const VITEST: &str = "node_modules/vitest/vitest.mjs";

fn command(suite: &str, program: &str, args: &[&str], cwd: &str) -> TestCommand {
    TestCommand { suite: suite.into(), program: program.into(), args: args.iter().map(|a| a.to_string()).collect(), cwd: cwd.into() }
}

/// O `npm test` pelo shell certo: no Windows `npm` é um `.cmd`, que um processo sem shell não acha.
fn npm_test() -> TestCommand {
    if cfg!(windows) {
        command("node", "cmd", &["/C", "npm", "test"], ".")
    } else {
        command("node", "npm", &["test"], ".")
    }
}

/// As suítes de um repositório pelo que ele tem. Pura.
pub fn layout_of(probe: &Probe) -> Layout {
    if probe.ade_markers {
        return Layout::AdeAgs;
    }
    let mut suites = Vec::new();
    if probe.cargo_root {
        suites.push(command("rust", "cargo", &["test"], "."));
    } else if probe.cargo_src_tauri {
        suites.push(command("rust", "cargo", &["test"], "src-tauri"));
    }
    if probe.tsconfig && probe.typescript_installed {
        suites.push(command("tsc", "node", &[TSC, "--noEmit"], "."));
    }
    if probe.vitest_dependency && probe.vitest_installed {
        suites.push(command("frontend", "node", &[VITEST, "run"], "."));
    } else if probe.npm_test {
        suites.push(npm_test());
    } else if probe.node_tests {
        suites.push(command("node", "node", &["--test"], "."));
    }
    Layout::Generic(suites)
}

/// O `scripts.test` vale? O `npm init` escreve um que só falha. Pura.
pub fn real_npm_test(script: &str) -> bool {
    let script = script.trim();
    !script.is_empty() && !script.contains("no test specified")
}

fn has_node_tests(root: &Path) -> bool {
    ["test", "tests"].iter().any(|dir| {
        std::fs::read_dir(root.join(dir)).is_ok_and(|entries| {
            entries.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                [".test.js", ".test.mjs", ".test.cjs"].iter().any(|ext| name.ends_with(ext))
            })
        })
    })
}

/// Olha o disco. Barato: só existência de arquivos e um package.json.
pub fn probe(root: &Path) -> Probe {
    let package: Option<serde_json::Value> = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let dependency = |name: &str| {
        package.as_ref().is_some_and(|p| {
            ["dependencies", "devDependencies"].iter().any(|key| p.get(key).and_then(|d| d.get(name)).is_some())
        })
    };
    Probe {
        ade_markers: root.join("src-tauri/Cargo.toml").is_file() && root.join("scripts/babel-parse-check.mjs").is_file(),
        cargo_root: root.join("Cargo.toml").is_file(),
        cargo_src_tauri: root.join("src-tauri/Cargo.toml").is_file(),
        tsconfig: root.join("tsconfig.json").is_file(),
        typescript_installed: root.join(TSC).is_file(),
        vitest_dependency: dependency("vitest"),
        vitest_installed: root.join(VITEST).is_file(),
        npm_test: package
            .as_ref()
            .and_then(|p| p.get("scripts")?.get("test")?.as_str().map(real_npm_test))
            .unwrap_or(false),
        node_tests: has_node_tests(root),
    }
}

pub fn detect(root: &Path) -> Layout {
    layout_of(&probe(root))
}

/// As suítes que um "gate completo" exige neste layout. Pura.
pub fn gate_suites(layout: &Layout) -> Vec<String> {
    match layout {
        Layout::AdeAgs => super::run::FULL_GATE_SUITES.iter().map(|s| s.to_string()).collect(),
        Layout::Generic(suites) => suites.iter().map(|s| s.suite.clone()).collect(),
    }
}

/// O que dizer ao agente sobre um repositório que não tem o layout do ADE-AGS. Vazio para o
/// ADE-AGS (o bloco de ambiente já fala das suítes dele). Pura.
pub fn environment_note(layout: &Layout) -> String {
    let Layout::Generic(suites) = layout else { return String::new() };
    if suites.is_empty() {
        return "\n\nPROJETO: não achei suítes de teste conhecidas neste repositório (Cargo, tsconfig + typescript, vitest, scripts.test do package.json ou test/*.test.js). `ags test` não tem o que rodar; valide do jeito do projeto e diga como no relato. As instruções acima sobre cargo, tsc, babel e frontend não se aplicam.".into();
    }
    let names: Vec<&str> = suites.iter().map(|s| s.suite.as_str()).collect();
    let lines: Vec<String> = suites.iter().map(|s| format!("- {}: {} {}", s.suite, s.program, s.args.join(" "))).collect();
    format!(
        "\n\nPROJETO: este repositório não tem o layout do ADE-AGS. Suítes detectadas (`ags test run <{}>`; `ags test affected` roda todas quando algo além de docs mudou):\n{}\nAs instruções acima sobre suítes que não estão nesta lista (cargo, tsc, babel, frontend) não se aplicam aqui.",
        names.join("|"),
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn o_ade_ags_continua_com_o_mapeamento_de_sempre() {
        let probe = Probe { ade_markers: true, cargo_src_tauri: true, tsconfig: true, ..Default::default() };
        assert_eq!(layout_of(&probe), Layout::AdeAgs);
        assert_eq!(gate_suites(&Layout::AdeAgs), ["rust", "tsc", "frontend"]);
        assert_eq!(environment_note(&Layout::AdeAgs), "");
    }

    #[test]
    fn um_repo_node_puro_roda_o_teste_dele_e_nao_o_rust() {
        let probe = Probe { node_tests: true, ..Default::default() };
        let Layout::Generic(suites) = layout_of(&probe) else { panic!("genérico") };
        assert_eq!(suites.len(), 1);
        assert_eq!((suites[0].suite.as_str(), suites[0].program.as_str()), ("node", "node"));
        assert_eq!(suites[0].args, ["--test"]);
        // Com scripts.test de verdade, vale o npm test.
        let npm = layout_of(&Probe { npm_test: true, node_tests: true, ..Default::default() });
        let Layout::Generic(suites) = npm else { panic!() };
        assert!(suites[0].args.iter().any(|a| a == "test"));
        assert!(!real_npm_test("echo \"Error: no test specified\" && exit 1"));
        assert!(real_npm_test("node --test"));
    }

    #[test]
    fn cargo_typescript_e_vitest_entram_so_quando_existem() {
        let probe = Probe { cargo_root: true, tsconfig: true, typescript_installed: true, vitest_dependency: true, vitest_installed: true, ..Default::default() };
        let layout = layout_of(&probe);
        assert_eq!(gate_suites(&layout), ["rust", "tsc", "frontend"]);
        let Layout::Generic(suites) = &layout else { panic!() };
        assert_eq!(suites[0].cwd, ".", "Cargo na raiz roda na raiz");
        // tsconfig sem typescript instalado não vira suíte.
        assert!(gate_suites(&layout_of(&Probe { tsconfig: true, ..Default::default() })).is_empty());
        assert!(environment_note(&layout).contains("ags test run <rust|tsc|frontend>"));
        assert!(environment_note(&Layout::Generic(vec![])).contains("não achei suítes"));
    }

    #[test]
    fn a_deteccao_le_o_disco() {
        let dir = std::env::temp_dir().join(format!("ags-project-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("test")).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
        std::fs::write(dir.join("test/api.test.js"), "").unwrap();
        let probe = probe(&dir);
        assert!(!probe.ade_markers && !probe.npm_test && probe.node_tests);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
