// Bench de complexidade do backend: gate por razão e orçamento calibrado.
//
//   node scripts/bench-rust.mjs                 # roda tudo (N = 5 processos frescos por caso)
//   node scripts/bench-rust.mjs --n 9           # mais amostras
//   node scripts/bench-rust.mjs --casos digest  # só os casos cujo nome contém "digest"
//   node scripts/bench-rust.mjs --json          # uma linha JSON por caso, para colar no doc
//
// Cada teste `#[ignore]` de `src-tauri/src/bench/` mede uma operação com uma dimensão pequena e a
// mesma 32× maior, e imprime `BENCH {json}`. Aqui cada teste roda em N processos FRESCOS (o
// binário de teste da lib, já compilado pelo `cargo test`), e cada caso é julgado pela mediana:
//
// - gate por razão: mediana(grande) / mediana(pequeno) ≤ RAZAO_MAX. Não depende da máquina e pega
//   um O(n²) ou um custo que cresce com o teto.
// - orçamento: mediana ≤ ceil(esperado × ESCALA × FOLGA). `esperado` foi medido na máquina de
//   referência; não há variável de ambiente para afrouxar (um orçamento que cada máquina ajusta não
//   pega nada). Mudou o desempenho de propósito? Meça de novo e atualize ESPERADO_MS no mesmo PR.
//
// Fora da suíte normal: roda no CI depois do `cargo test`, que já deixa o binário pronto.
// Detalhes e números medidos: `docs/ade-ags/bench/COMPLEXIDADE.md`.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Quanto o caso grande pode custar a mais que o pequeno com a dimensão 32× maior. */
export const RAZAO_MAX = 4;
/**
 * Máquina de referência → runner do CI (ubuntu-22.04 x64). NÃO MEDIDO: chute conservador até o
 * primeiro run do CI; aí troque pelo quociente medido (mediana do CI ÷ mediana da referência).
 */
export const ESCALA = 3;
/** Variação aceita acima do esperado já escalado. */
export const FOLGA = 1.25;

/**
 * Mediana na máquina de referência (Apple Silicon, macOS, perfil `test` = debug), em ms, medida
 * em 2026-11-02 com `node scripts/bench-rust.mjs --n 9 --json`, com a máquina carregada (Apple M2,
 * 8 núcleos, load average ~20–28): numa máquina ociosa os tempos são menores. Ver docs/ade-ags/bench/COMPLEXIDADE.md.
 */
export const ESPERADO_MS = {
  "digest/misto": { pequeno: 750, grande: 752 },
  "digest/so-erros": { pequeno: 392, grande: 436 },
  "scrollback/ingestao": { pequeno: 13, grande: 24 },
  "scrollback/fim": { pequeno: 191, grande: 207 },
  "canal-tail/primeira-leitura": { pequeno: 147, grande: 152 },
  "canal-tail/incremental": { pequeno: 131, grande: 104 },
};

/** Os testes do bench (`bench::<nome>`) e os casos que cada um imprime. */
export const TESTES = {
  digest_custo_por_linha: ["digest/misto", "digest/so-erros"],
  scrollback_ingestao_nao_cresce_com_o_teto: ["scrollback/ingestao"],
  scrollback_fim_nao_cresce_com_o_buffer: ["scrollback/fim"],
  canal_tail_primeira_leitura_nao_cresce_com_o_arquivo: ["canal-tail/primeira-leitura"],
  canal_tail_leitura_incremental_nao_cresce_com_o_arquivo: ["canal-tail/incremental"],
};

export function orcamento(esperadoMs) {
  return Math.ceil(esperadoMs * ESCALA * FOLGA);
}

export function mediana(valores) {
  const v = [...valores].sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

/**
 * As amostras `BENCH {…}` da saída de um processo. Com `--nocapture`, o libtest escreve
 * `test bench::x ... ` sem quebra de linha antes da primeira saída do teste: a marca pode vir no
 * meio da linha.
 */
export function lerAmostras(saida) {
  return [...saida.matchAll(/BENCH (\{[^\n]*\})/g)].map((m) => JSON.parse(m[1]));
}

/** Julga um caso a partir das amostras (uma por processo). */
export function julgar(caso, amostras, esperado = ESPERADO_MS[caso]) {
  const pequeno = mediana(amostras.map((a) => a.pequeno_ms));
  const grande = mediana(amostras.map((a) => a.grande_ms));
  const razao = grande / pequeno;
  const falhas = [];
  if (!(razao <= RAZAO_MAX)) falhas.push(`razão ${razao.toFixed(2)}× > ${RAZAO_MAX}× (dimensão 32× maior)`);
  const calibrado = esperado && esperado.pequeno > 0 && esperado.grande > 0;
  const orc = calibrado ? { pequeno: orcamento(esperado.pequeno), grande: orcamento(esperado.grande) } : null;
  if (orc) {
    if (pequeno > orc.pequeno) falhas.push(`pequeno ${pequeno.toFixed(1)} ms > orçamento ${orc.pequeno} ms`);
    if (grande > orc.grande) falhas.push(`grande ${grande.toFixed(1)} ms > orçamento ${orc.grande} ms`);
  } else {
    falhas.push("sem valor esperado calibrado em ESPERADO_MS");
  }
  return { caso, n: amostras.length, pequeno, grande, razao, orcamento: orc, falhas };
}

function binarioDeTeste() {
  const r = spawnSync("cargo", ["test", "--lib", "--no-run", "--message-format=json"], {
    cwd: join(RAIZ, "src-tauri"),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.status !== 0) throw new Error("cargo test --lib --no-run falhou");
  const exe = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l))
    .find((m) => m.reason === "compiler-artifact" && m.profile?.test && m.target?.kind?.some((k) => k.endsWith("lib")) && m.executable)?.executable;
  if (!exe) throw new Error("não achei o binário de teste da lib na saída do cargo");
  return exe;
}

function main(argv) {
  const arg = (nome) => {
    const i = argv.indexOf(nome);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const n = Number(arg("--n") ?? 5);
  const filtro = arg("--casos");
  const json = argv.includes("--json");
  const exe = binarioDeTeste();

  const amostras = {};
  for (const [teste, casos] of Object.entries(TESTES)) {
    if (filtro && !casos.some((c) => c.includes(filtro))) continue;
    for (let i = 0; i < n; i++) {
      // Um processo fresco por amostra: nada de cache, alocador ou JIT de uma amostra vaza na outra.
      const r = spawnSync(exe, [`bench::${teste}`, "--exact", "--ignored", "--nocapture", "--test-threads=1"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0) {
        console.error(r.stdout, r.stderr);
        throw new Error(`bench::${teste} falhou (status ${r.status})`);
      }
      for (const a of lerAmostras(r.stdout)) (amostras[a.caso] ??= []).push(a);
    }
  }

  const resultados = Object.entries(amostras).map(([caso, lista]) => julgar(caso, lista));
  for (const r of resultados) {
    if (json) {
      console.log(JSON.stringify({ caso: r.caso, n: r.n, pequeno_ms: +r.pequeno.toFixed(3), grande_ms: +r.grande.toFixed(3), razao: +r.razao.toFixed(3) }));
      continue;
    }
    const orc = r.orcamento ? ` · orçamento ${r.orcamento.pequeno}/${r.orcamento.grande} ms` : "";
    const estado = r.falhas.length ? `FALHOU: ${r.falhas.join("; ")}` : "ok";
    console.log(`${r.caso.padEnd(28)} n=${r.n}  pequeno ${r.pequeno.toFixed(2)} ms  grande ${r.grande.toFixed(2)} ms  razão ${r.razao.toFixed(2)}×${orc}  ${estado}`);
  }
  return resultados.some((r) => r.falhas.length > 0) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
