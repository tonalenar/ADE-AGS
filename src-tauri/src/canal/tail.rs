//! Seguir um arquivo JSONL que outro processo vai escrevendo: lê só o que cresceu desde a última
//! vez, entrega linhas completas e guarda o pedaço sem `\n` para a próxima.
//!
//! O arquivo é aberto e fechado a cada leitura (nenhum handle fica preso: o Codex compacta e
//! renomeia rollouts antigos, e no Windows um handle aberto atrapalharia). Um transcript pode
//! ter centenas de MB (há um rollout de 187 MB nesta máquina): o começo nunca é lido; a
//! primeira leitura pega só a janela do fim.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Quanto do fim do arquivo se lê na primeira vez, para saber o estado atual.
pub const BOOT_WINDOW: u64 = 512 * 1024;
/// Se o arquivo cresceu mais que isto entre duas leituras, pula para o fim (e relê a janela).
pub const MAX_CATCHUP: u64 = 8 * 1024 * 1024;
/// Uma linha maior que isto é descartada (uma saída de ferramenta gigante): não diz nada de estado.
pub const MAX_LINE: usize = 4 * 1024 * 1024;

#[derive(Debug, Default, PartialEq)]
pub struct Batch {
    pub lines: Vec<Vec<u8>>,
    /// O arquivo encolheu ou o leitor pulou um trecho: o estado anterior não vale mais.
    pub reset: bool,
}

#[derive(Debug)]
pub struct Tailer {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// Descartando o resto de uma linha grande demais (até o próximo `\n`).
    skipping: bool,
    started: bool,
}

impl Tailer {
    pub fn new(path: impl Into<PathBuf>) -> Tailer {
        Tailer { path: path.into(), offset: 0, partial: Vec::new(), skipping: false, started: false }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// Lê o que há de novo. A primeira chamada lê a janela do fim (`BOOT_WINDOW`), começando na
    /// primeira linha inteira dela.
    pub fn poll(&mut self) -> io::Result<Batch> {
        let mut file = File::open(&self.path)?;
        let len = file.metadata()?.len();
        let mut batch = Batch::default();
        if !self.started || len < self.offset || len - self.offset > MAX_CATCHUP {
            batch.reset = self.started;
            self.started = true;
            self.partial.clear();
            self.skipping = false;
            let start = len.saturating_sub(BOOT_WINDOW);
            self.offset = start;
            // Começou no meio de uma linha: o pedaço até o primeiro `\n` é descartado.
            self.skipping = start > 0;
        }
        if len == self.offset {
            return Ok(batch);
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        file.take(len - self.offset).read_to_end(&mut buf)?;
        self.offset += buf.len() as u64;
        for chunk in buf.split_inclusive(|b| *b == b'\n') {
            let complete = chunk.last() == Some(&b'\n');
            if self.skipping {
                if complete {
                    self.skipping = false;
                }
                continue;
            }
            self.partial.extend_from_slice(chunk);
            if self.partial.len() > MAX_LINE {
                self.partial.clear();
                self.skipping = !complete;
                continue;
            }
            if complete {
                let mut line = std::mem::take(&mut self.partial);
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                if !line.is_empty() {
                    batch.lines.push(line);
                }
            }
        }
        Ok(batch)
    }
}
