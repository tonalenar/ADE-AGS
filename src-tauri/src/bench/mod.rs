//! Bench de complexidade: cada caso mede a mesma operação com uma dimensão 32× maior e imprime
//! uma linha `BENCH {json}` com os dois tempos. Quem decide se passou é `scripts/bench-rust.mjs`,
//! que roda cada caso em N processos frescos, tira a mediana e aplica o gate por razão (custo
//! ≤ 4×) e o orçamento calibrado. Ver `docs/ade-ags/bench/COMPLEXIDADE.md`.
//!
//! Fica fora da suíte normal (`#[ignore]`): um teste de tempo dentro do `cargo test` paralelo
//! mede a concorrência dos outros testes, não o código.

use std::hint::black_box;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use crate::canal::tail::Tailer;
use crate::orchestrator::digest::digest;
use crate::terminal::{push_capped, tail_start};

/// A dimensão que cresce entre o caso pequeno e o grande.
const FATOR: usize = 32;

fn ms<F: FnMut()>(mut f: F) -> f64 {
    let inicio = Instant::now();
    f();
    inicio.elapsed().as_secs_f64() * 1000.0
}

/// Uma amostra por variante, depois de um aquecimento de cada (o primeiro uso paga alocação e
/// page cache). A ordem alterna para nenhuma variante sempre pegar o processo "mais quente".
fn medir<P: FnMut(), G: FnMut()>(caso: &str, mut pequeno: P, mut grande: G) {
    pequeno();
    grande();
    let g = ms(&mut grande);
    let p = ms(&mut pequeno);
    println!("BENCH {{\"caso\":\"{caso}\",\"pequeno_ms\":{p:.4},\"grande_ms\":{g:.4}}}");
}

/// Gerador determinístico (LCG): o mesmo texto em toda máquina, sem depender de `rand`.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

/// Um log de build parecido com o que passa pelo `digest`: cor ANSI, spinner redesenhado,
/// linhas repetidas, avisos e uma fração de erros distintos.
fn log_misto(linhas: usize) -> String {
    let mut rng = Lcg(42);
    let mut out = String::with_capacity(linhas * 60);
    for i in 0..linhas {
        match rng.next() % 40 {
            0 => out.push_str(&format!("\x1b[31merror[E0425]\x1b[0m: cannot find value `x_{i}` in this scope\n")),
            1 | 2 => out.push_str(&format!("warning: unused variable `y_{}`\n", i % 7)),
            3..=9 => out.push_str("⠋ building\n"),
            _ => out.push_str(&format!("   \x1b[32mCompiling\x1b[0m crate_{i} v0.1.{}\n", rng.next() % 100)),
        }
    }
    out
}

/// O pior caso do `digest`: toda linha é um erro diferente (um `tsc` com milhares de erros).
/// Linhas curtas de propósito: o custo linear por linha cai e o de comparar com os erros já vistos
/// não, então um O(n²) aparece na razão mesmo no perfil de teste (sem otimização).
fn log_so_erros(linhas: usize) -> String {
    (0..linhas).map(|i| format!("error: e{i}\n")).collect()
}

/// Com 250 linhas o O(n²) que já existiu no `push_unique` ficava escondido (2,5×); com 1.000 ele
/// aparecia (6,8×). Não diminua sem medir de novo.
const LINHAS_DIGEST: usize = 1_000;
/// Quantas vezes o pequeno roda por amostra (o tempo é escalado para FATOR rodadas).
const RODADAS_PEQUENO: usize = 4;

/// O `digest` é linear no texto por natureza: o que se compara é o custo POR LINHA. Com 32×
/// mais linhas, o custo por linha não pode passar de 4× (um O(n²) dá ~32×).
///
/// Sem aquecimento: cada amostra leva centenas de ms no perfil de teste, e o bench inteiro tem de
/// caber no CI.
#[test]
#[ignore = "bench: roda via scripts/bench-rust.mjs, fora da suíte"]
fn digest_custo_por_linha() {
    for (caso, gerar) in [("digest/misto", log_misto as fn(usize) -> String), ("digest/so-erros", log_so_erros)] {
        let pequeno = gerar(LINHAS_DIGEST);
        let grande = gerar(LINHAS_DIGEST * FATOR);
        let g = ms(|| {
            black_box(digest(black_box(&grande), 40));
        });
        // Escalado para FATOR rodadas: os dois lados contam o mesmo total de linhas, e a razão dos
        // tempos é a razão do custo por linha.
        let p = ms(|| {
            for _ in 0..RODADAS_PEQUENO {
                black_box(digest(black_box(&pequeno), 40));
            }
        }) * (FATOR / RODADAS_PEQUENO) as f64;
        println!("BENCH {{\"caso\":\"{caso}\",\"pequeno_ms\":{p:.4},\"grande_ms\":{g:.4}}}");
    }
}

const MIB: usize = 1024 * 1024;
/// Os tetos reais (`MAX_BUFFER_BYTES` e `TRIM_MARGIN_BYTES` de `pty_manager.rs`); o pequeno é 32× menor.
const TETO_GRANDE: usize = 3 * MIB;
const MARGEM_GRANDE: usize = 512 * 1024;

/// O PTY lê em pedaços de até 4 KiB. A mesma saída (64 MiB) entra num scrollback de 96 KiB e
/// num de 3 MiB: o custo não pode crescer com o teto (sem a margem de corte em lote, cada
/// pedaço movia o buffer inteiro, e o grande custava ~32× mais).
#[test]
#[ignore = "bench: roda via scripts/bench-rust.mjs, fora da suíte"]
fn scrollback_ingestao_nao_cresce_com_o_teto() {
    let pedaco = vec![b'x'; 4096];
    let total = 64 * MIB;
    let ingerir = |teto: usize, margem: usize| {
        let mut data = Vec::new();
        for _ in 0..total / pedaco.len() {
            push_capped(&mut data, black_box(&pedaco), teto, margem);
        }
        black_box(data.len());
    };
    medir(
        "scrollback/ingestao",
        || ingerir(TETO_GRANDE / FATOR, MARGEM_GRANDE / FATOR),
        || ingerir(TETO_GRANDE, MARGEM_GRANDE),
    );
}

/// Quem confere a tela (Vigia, `peer tell`) lê só o fim do scrollback: o custo depende do
/// tamanho pedido (64 KiB), não do buffer.
#[test]
#[ignore = "bench: roda via scripts/bench-rust.mjs, fora da suíte"]
fn scrollback_fim_nao_cresce_com_o_buffer() {
    let pequeno = vec![b'a'; TETO_GRANDE / FATOR];
    let grande = vec![b'a'; TETO_GRANDE];
    let ler_fim = |data: &[u8]| {
        for _ in 0..2_000 {
            let inicio = tail_start(black_box(data), 64 * 1024);
            black_box(String::from_utf8_lossy(&data[inicio..]).into_owned());
        }
    };
    medir("scrollback/fim", || ler_fim(&pequeno), || ler_fim(&grande));
}

/// Um arquivo temporário do bench, apagado no fim. Nunca em `~/.ags`.
struct Arquivo(PathBuf);
impl Arquivo {
    fn jsonl(nome: &str, bytes: usize) -> Arquivo {
        let path = std::env::temp_dir().join(format!("ags-bench-{}-{nome}.jsonl", std::process::id()));
        let linha = format!("{{\"type\":\"event\",\"payload\":\"{}\"}}\n", "p".repeat(200));
        let mut f = std::io::BufWriter::new(std::fs::File::create(&path).expect("criar arquivo do bench"));
        let mut escrito = 0;
        while escrito < bytes {
            f.write_all(linha.as_bytes()).expect("escrever arquivo do bench");
            escrito += linha.len();
        }
        f.flush().expect("flush do arquivo do bench");
        Arquivo(path)
    }

    fn acrescentar(&self, bytes: usize) {
        let linha = format!("{{\"type\":\"delta\",\"payload\":\"{}\"}}\n", "d".repeat(100));
        let mut f = std::fs::OpenOptions::new().append(true).open(&self.0).expect("abrir arquivo do bench");
        let mut escrito = 0;
        while escrito < bytes {
            f.write_all(linha.as_bytes()).expect("acrescentar ao arquivo do bench");
            escrito += linha.len();
        }
    }
}
impl Drop for Arquivo {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A primeira leitura de um transcript lê só a janela do fim (`BOOT_WINDOW`): um arquivo 32×
/// maior (1 MiB contra 32 MiB) custa o mesmo.
#[test]
#[ignore = "bench: roda via scripts/bench-rust.mjs, fora da suíte"]
fn canal_tail_primeira_leitura_nao_cresce_com_o_arquivo() {
    let pequeno = Arquivo::jsonl("boot-p", MIB);
    let grande = Arquivo::jsonl("boot-g", MIB * FATOR);
    let ler = |a: &Arquivo| {
        for _ in 0..20 {
            let mut t = Tailer::new(&a.0);
            black_box(t.poll().expect("poll do bench").lines.len());
        }
    };
    medir("canal-tail/primeira-leitura", || ler(&pequeno), || ler(&grande));
}

/// Depois da primeira, cada leitura pega só o que cresceu (16 KiB por vez, 200 vezes): o tamanho do arquivo
/// não entra no custo. Só o `poll` é cronometrado; o acréscimo fica fora da conta.
#[test]
#[ignore = "bench: roda via scripts/bench-rust.mjs, fora da suíte"]
fn canal_tail_leitura_incremental_nao_cresce_com_o_arquivo() {
    let pequeno = Arquivo::jsonl("inc-p", MIB);
    let grande = Arquivo::jsonl("inc-g", MIB * FATOR);
    let incremental = |a: &Arquivo| {
        let mut t = Tailer::new(&a.0);
        t.poll().expect("poll inicial do bench");
        let mut total = 0.0;
        for _ in 0..200 {
            a.acrescentar(16 * 1024);
            total += ms(|| {
                black_box(t.poll().expect("poll do bench").lines.len());
            });
        }
        total
    };
    // Aquecimento, depois uma amostra de cada (o mesmo que `medir`, mas somando só os polls).
    incremental(&pequeno);
    incremental(&grande);
    let g = incremental(&grande);
    let p = incremental(&pequeno);
    println!("BENCH {{\"caso\":\"canal-tail/incremental\",\"pequeno_ms\":{p:.4},\"grande_ms\":{g:.4}}}");
}
