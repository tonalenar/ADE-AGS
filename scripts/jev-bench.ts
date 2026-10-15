/**
 * Benchmark REPETÍVEL do piloto do Jev (`ags portal act` / `browser_act`): 20 tarefas de dificuldade crescente, com
 * critério de sucesso verificável pela PÁGINA, e as medições para comparar ANTES/DEPOIS de uma correção.
 *
 *   bun scripts/jev-bench.ts --list
 *   bun scripts/jev-bench.ts --serve                       # só serve as páginas locais (para abrir à mão com `ags open`)
 *   bun scripts/jev-bench.ts --sim                         # o laço real contra páginas simuladas; sem custo, sem rede
 *   bun scripts/jev-bench.ts --sim --label depois --compare docs/ade-ags/bench/antes-sim.json
 *   bun scripts/jev-bench.ts --real --only L01-icones-sem-nome,L04-busca-com-botao --max-real 2   # Jev real: CUSTA cota
 *
 * Opções: --out <arquivo.json> (padrão bench-results/jev-bench-<modo>-<label>.json, com .md ao lado) · --label <nome>
 *   · --compare <json> (coluna ANTES) · --port <n> (servidor das fixtures, padrão 8765) · --no-visual (sim sem foto) · --verbose (os passos de cada tarefa)
 *   Real: --public (inclui Wikipedia/Amazon) · --demo-login (inclui SauceDemo) · --max-real N (padrão 5 tarefas)
 *   · --max-probes N (padrão 60 consultas ao Jev no pior caso) · --portal <nome> (reaproveita um portal) · --yes
 *
 * `--real` fala com o app já aberto pelo CLI `ags` (precisa de um terminal de agente do ADE AGS). Nunca faz login real,
 * compra ou envio de dado pessoal: as tarefas públicas param antes de finalizar e o critério `forbid` acusa quem passar.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  buildReport, canStart, describeCriterion, emptyPhases, evaluate, parseActReport, phasesFromReport, renderMarkdown, select,
  type BenchReport, type BenchTask, type TaskRun,
} from "./bench/core";
import { runSimTask } from "./bench/sim";
import { TASKS } from "./bench/tasks";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "bench-fixture");

// ── Argumentos ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length && !argv[at + 1].startsWith("--") ? argv[at + 1] : undefined;
};
const intValue = (name: string, fallback: number): number => {
  const raw = value(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const mode: "sim" | "real" | null = flag("real") ? "real" : flag("sim") ? "sim" : null;
const only = value("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const label = value("label") ?? "rodada";
const port = intValue("port", 8765);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (flag("list")) {
  for (const task of TASKS) {
    console.log(`${task.id}  [${task.kind}${task.sim ? "+sim" : ""}${task.demoLogin ? ", login-demo" : ""}] dif.${task.difficulty} ≤${task.maxSteps} passos`);
    console.log(`    ${task.title}`);
    console.log(`    objetivo: ${task.goal}`);
    console.log(`    sucesso:  ${describeCriterion(task.success)}${task.forbid ? ` · proibido: ${describeCriterion(task.forbid)}` : ""}`);
  }
  console.log(`\n${TASKS.length} tarefas (${TASKS.filter((t) => t.kind === "local").length} locais, ${TASKS.filter((t) => t.kind === "public").length} públicas).`);
  process.exit(0);
}
if (!mode && !flag("serve")) fail("Use --list, --sim, --real ou --serve. Veja o cabeçalho de scripts/jev-bench.ts.");


// ── Servidor das fixtures ───────────────────────────────────────────

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function serveFixtures(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = resolve(FIXTURES, `.${normalize(path === "/" ? "/index.html" : path)}`);
    if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404).end("não encontrado"); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise((ok, err) => { server.once("error", err); server.listen(port, "127.0.0.1", () => ok(server)); });
}

const absolute = (task: BenchTask) => (task.url.startsWith("http") ? task.url : `http://localhost:${port}${task.url}`);

if (flag("serve")) {
  const live = await serveFixtures();
  console.log(`Fixtures em http://localhost:${port}/ (Ctrl+C para parar)`);
  await new Promise(() => live.ref());
}
if (!mode) process.exit(2);

const selection = select(TASKS, {
  only, kind: undefined, includePublic: flag("public"), includeDemoLogin: flag("demo-login"), simOnly: mode === "sim",
});
if (selection.unknown.length > 0) fail(`Ids desconhecidos: ${selection.unknown.join(", ")} (use --list).`);
if (selection.run.length === 0) fail("Nenhuma tarefa selecionada.");
for (const s of selection.skipped) console.log(`(pulada ${s.id}: ${s.why})`);

// ── Modo real: o CLI `ags` ──────────────────────────────────────────

function ags(args: string[], timeoutMs = 150_000): string {
  return execFileSync("ags", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}

async function confirmReal(tasks: BenchTask[], maxProbes: number): Promise<void> {
  console.log("\nMODO REAL: cada tarefa consulta o Jev de verdade (custo/cota) e navega num portal do app.");
  for (const task of tasks) console.log(`  - ${task.id} → ${absolute(task)} (até ${task.maxSteps} passos)`);
  console.log(`Teto: ${tasks.length} tarefas, até ${maxProbes} consultas ao Jev no pior caso. Sem login real, compra ou dado pessoal.`);
  if (flag("yes")) return;
  if (!process.stdin.isTTY) fail("Sem terminal interativo: confirme com --yes.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Digite CONFIRMO para gastar a cota do Jev: ');
  rl.close();
  if (answer.trim() !== "CONFIRMO") fail("Não confirmado. Nada foi rodado.");
}

async function runRealTask(task: BenchTask, portal: string): Promise<TaskRun> {
  const crash = (note: string): TaskRun => ({
    id: task.id, outcome: "crash", criterionOk: false, forbidden: false, steps: 0, autoFills: 0, photos: 0, totalMs: 0,
    stepMs: [], phases: emptyPhases(), timing: "reported", finalUrl: "", note: note.slice(0, 200),
  });
  try {
    ags(["portal", "navigate", portal, absolute(task)], 60_000);
  } catch (e) {
    return crash(`navegar falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
  const args = ["portal", "act", portal, task.goal, ...(task.fills ?? []).flatMap((f) => ["--fill", f]), "--steps", String(task.maxSteps)];
  const started = performance.now();
  let text: string;
  try {
    text = ags(args, 150_000);
  } catch (e) {
    return crash(`act falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
  const totalMs = Math.round(performance.now() - started);
  const report = parseActReport(text);
  let finalSnapshot = report.finalSnapshot;
  try { finalSnapshot = ags(["portal", "snapshot", portal], 60_000); } catch { /* fica com a página embutida no relatório */ }
  const evaluated = evaluate(task, finalSnapshot);
  // O relatório do act traz a linha TEMPOS (somas por fase) e o tempo de cada passo que agiu; o que sobra do relógio de
  // quem rodou vira «outros». Sem o tempo de passo (relatório antigo), vale a média.
  const { phases, probes } = phasesFromReport(report, totalMs);
  const perStep = report.steps > 0 ? totalMs / report.steps : totalMs;
  return {
    id: task.id, outcome: report.outcome ?? "crash", ...evaluated,
    steps: report.steps, autoFills: report.autoFills, photos: report.photos, totalMs,
    stepMs: report.stepMs.length > 0 ? report.stepMs : Array.from({ length: Math.max(1, report.steps) }, () => perStep),
    phases, timing: "reported", blocked: report.blocked, ...(probes !== undefined ? { probes } : {}),
    ...(report.outcome === null ? { note: "relatório do act não reconhecido" } : {}),
  };
}

// ── Execução ────────────────────────────────────────────────────────

function commit(): string | undefined {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return undefined; }
}

const runs: TaskRun[] = [];
const startedAt = new Date().toISOString();
let server: Server | null = null;

if (mode === "sim") {
  for (const task of selection.run) {
    const run = await runSimTask(task, { visual: !flag("no-visual") });
    runs.push(run);
    console.log(`${run.criterionOk ? "ok  " : "FALHA"} ${task.id} — ${run.outcome}, ${run.steps} passos, ${(run.totalMs / 1000).toFixed(1)} s virtuais`);
    if (flag("verbose")) for (const line of [...(run.log ?? []), ...(run.note ? [`nota: ${run.note}`] : [])]) console.log(`      ${line}`);
  }
} else {
  const budget = { maxTasks: intValue("max-real", 5), maxProbes: intValue("max-probes", 60) };
  const planned: BenchTask[] = [];
  let worst = 0;
  for (const task of selection.run) {
    const verdict = canStart(budget, planned.length, worst, task);
    if (!verdict.ok) { console.log(`(parou de planejar em ${task.id}: ${verdict.why})`); break; }
    planned.push(task);
    worst += task.maxSteps;
  }
  if (planned.length === 0) fail("O teto não deixa rodar nenhuma tarefa: aumente --max-probes.");
  await confirmReal(planned, budget.maxProbes);
  server = await serveFixtures();
  const portal = value("portal") ?? "bench-jev";
  if (!value("portal")) {
    try { ags(["portal", "create", portal, absolute(planned[0])], 60_000); } catch (e) { server.close(); fail(`Não consegui criar o portal (rode num terminal de agente do app): ${e instanceof Error ? e.message : String(e)}`); }
  }
  let used = 0;
  for (const task of planned) {
    const run = await runRealTask(task, portal);
    runs.push(run);
    used += run.probes ?? Math.max(run.steps + run.photos, 1);
    console.log(`${run.criterionOk ? "ok  " : "FALHA"} ${task.id} — ${run.outcome}, ${run.steps} passos, ${(run.totalMs / 1000).toFixed(1)} s (${used} sondas até aqui)`);
  }
  server.close();
}

const report: BenchReport = buildReport({ label, mode, startedAt, commit: commit() }, runs);
let baseline: BenchReport | undefined;
const comparePath = value("compare");
if (comparePath) {
  try { baseline = JSON.parse(readFileSync(comparePath, "utf8")) as BenchReport; } catch (e) { fail(`--compare ilegível (${comparePath}): ${e instanceof Error ? e.message : String(e)}`); }
}
const markdown = renderMarkdown(TASKS, report, baseline);
const out = value("out") ?? join("bench-results", `jev-bench-${mode}-${label}.json`);
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
const mdPath = out.replace(/\.json$/i, "") + ".md";
writeFileSync(mdPath, `${markdown}\n`);
console.log(`\n${markdown}\n\nJSON: ${out}\nMarkdown: ${mdPath}`);
process.exit(0);
