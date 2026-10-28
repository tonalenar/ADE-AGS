//! Formato das fixtures dos testes por replay (`docs/ade-ags/REPLAY_TESTES.md`).
//!
//! Uma fixture é a saída crua de um PTY, em pedaços com o instante em que chegaram, mais o estado que
//! os detectores devem ver em alguns instantes. As mesmas fixtures alimentam o harness do Rust
//! (`ipc/commands/replay_test.rs`) e o do front (`src/features/terminal/tests/replayHarness.ts`).
//! Só existe nos testes.

use base64::Engine as _;
use serde::Deserialize;

/// Onde ficam as fixtures (compartilhadas com o vitest).
pub(crate) const FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/features/terminal/tests/fixtures/replay");

/// Um pedaço do que o processo escreveu: texto (UTF-8 válido, escapes no lugar) ou os bytes em base64.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Chunk {
    pub at_ms: u64,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub b64: Option<String>,
}

impl Chunk {
    /// Os bytes do pedaço, como chegaram do PTY.
    pub(crate) fn bytes(&self) -> Result<Vec<u8>, String> {
        match (&self.data, &self.b64) {
            (Some(text), None) => Ok(text.as_bytes().to_vec()),
            (None, Some(b64)) => base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string()),
            _ => Err(format!("pedaço em {} ms: precisa de exatamente um de data/b64", self.at_ms)),
        }
    }
}

#[derive(Deserialize, Debug, Clone, Default)]
pub(crate) struct Xfail {
    #[serde(default)]
    pub rust: Vec<String>,
    #[serde(default)]
    pub ts: Vec<String>,
    #[serde(default)]
    pub reason: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Checkpoint {
    pub at_ms: u64,
    #[serde(default)]
    pub since: Option<u64>,
    #[serde(default)]
    pub label: String,
    pub expect: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub xfail: Option<Xfail>,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct Origin {
    pub kind: String,
    #[serde(default)]
    pub basis: String,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct Fixture {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub agent: String,
    pub title: String,
    pub origin: Origin,
    #[serde(default)]
    pub message: Option<String>,
    pub chunks: Vec<Chunk>,
    pub checkpoints: Vec<Checkpoint>,
}

impl Fixture {
    /// Tudo o que o processo escreveu até `at_ms` (inclusive): o buffer do PTY naquele instante.
    pub(crate) fn output_until(&self, at_ms: u64) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        for chunk in self.chunks.iter().take_while(|c| c.at_ms <= at_ms) {
            out.extend(chunk.bytes()?);
        }
        Ok(out)
    }
}

/// Todas as fixtures da pasta, com o nome do arquivo.
pub(crate) fn load_fixtures() -> Vec<(String, Fixture)> {
    let mut out: Vec<(String, Fixture)> = std::fs::read_dir(FIXTURES_DIR)
        .expect("a pasta de fixtures de replay existe")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path).unwrap();
            let fixture: Fixture = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            (name, fixture)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}
