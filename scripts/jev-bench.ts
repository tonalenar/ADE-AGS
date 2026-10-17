/**
 * Benchmark REPETÍVEL do piloto do Jev (`ags portal act` / `browser_act`), v2 (plano v2, Fase 0.3/0.4): 33 tarefas
 * (27 locais, 6 públicas, 2 delas SONDAS fora dos portões), com critério de sucesso verificável pela PÁGINA, repetição por
 * tarefa com ordem embaralhada por semente, e as medições para comparar ANTES/DEPOIS de uma correção.
 *
 *   bun scripts/jev-bench.ts --list
 *   bun scripts/jev-bench.ts --serve                       # só serve as páginas locais (para abrir à mão com `ags open`)
 *   bun scripts/jev-bench.ts --sim                         # o laço real contra páginas simuladas; sem custo, sem rede
 *   bun scripts/jev-bench.ts --sim --repeat 3 --seed 1 --label v2-base --out docs/ade-ags/bench/v2-base-sim.json
 *   bun scripts/jev-bench.ts --sim --label depois --compare docs/ade-ags/bench/antes-sim.json   # JSON antigo (schema 1) também
 *   bun scripts/jev-bench.ts --real --only L01-icones-sem-nome,L04-busca-com-botao --max-real 2   # Jev real: CUSTA cota
 *
 * Opções: --out <arquivo.json> (padrão bench-results/jev-bench-<modo>-<label>.json, com .md ao lado) · --label <nome>
 *   · --compare <json> (coluna ANTES) · --port <n> (servidor das fixtures, padrão 8765) · --no-visual (sim sem foto) · --verbose (os passos de cada tarefa)
 *   · --repeat N (repetições por tarefa, padrão 1) · --seed S (semente da ordem e da latência simulada, padrão 1)
 *   · --no-alternate (sem inverter a ordem nas repetições ímpares) · --set v1|v2|teste (só uma leva; teste = protocolo J2)
 *   · --history (grava também docs/ade-ags/bench/historico/<data>-<modo>-<label>.json/.md e uma linha no índice HISTORICO.md)
 *   · --gate (Fase 7: sai com código 1 se o portão de liberação falhar: sucesso ≥ 90%, falso «feito» ≤ 2%, passo p50 ≤ 700 ms, 0 travamentos)
 *   · --with-expect (Fase 5: passa ao `act` os `--expect` equivalentes ao critério de cada tarefa e mede NÃO CONFERE / «verificado» errado)
 *   · --sim-guard (sim: liga a guarda semântica simulada da Fase 2.1, para ver o «depois»)
 *   · --no-reset (real: NÃO zera cookies/storage/livro-razão do portal antes de cada rodada; padrão é zerar, J1)
 *   Real: --public (inclui Wikipedia/Amazon) · --demo-login (inclui SauceDemo) · --max-real N (padrão 5 rodadas, já contando as repetições)
 *   · --max-probes N (padrão 60 consultas ao Jev no pior caso) · --portal <nome> (reaproveita um portal) · --yes
 *
 * Servidor das fixtures: `?delay=<ms>` atrasa QUALQUER resposta (HTML ou `/api/*`, teto 30 s) para reproduzir a busca
 * lenta; `/api/busca`, `/api/filtro`, `/api/sugestoes`, `/api/carrinho` respondem JSON fictício às fixtures por fetch.
 *
 * `--real` fala com o app já aberto pelo CLI `ags` (precisa de um terminal de agente do ADE AGS). Nunca faz login real,
 * compra ou envio de dado pessoal: as tarefas públicas param antes de finalizar e o critério `forbid` acusa quem passar.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  buildReport, canStart, expectsFor, gateCheck, mergeRuns, renderTrend, infraTooHigh, isInfraFailure, unwrapCli, describeCriterion, emptyPhases, evaluate, parseActReport, phasesFromReport, renderMarkdown, select,
  fixtureApi, fixtureSearchPage, hashSeed, isWindowHang, mergeQueries, parseDelay, queriesFromReport, repetitionPlan,
  type BenchReport, type BenchTask, type Phases, type QueryStats, type TaskRun, type WindowStats,
} from "./bench/core";
import { runSimTask } from "./bench/sim";
import { TASKS } from "./bench/tasks";
import { TEST_TASKS } from "./bench/tasks-teste";

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

// `--merge a.json,b.json#id+id,… [--causes causas.json] [--baseline antes.json] --label x --out final.json`: junta rodadas parciais (a última de cada tarefa vale)
// e anota a causa das falhas. Não roda nada.
const label = value("label") ?? "rodada";
if (flag("merge")) {
  // `arquivo.json#L13-abas+L15-quantidade-sem-enter` pega só essas tarefas do arquivo (as outras são de outra rodada).
  const parts = (value("merge") ?? "").split(",").filter(Boolean).map((spec) => {
    const [path, only] = spec.split("#");
    const part = JSON.parse(readFileSync(path, "utf8")) as BenchReport;
    const ids = only?.split("+").filter(Boolean);
    return ids && ids.length > 0 ? { ...part, runs: part.runs.filter((r) => ids.includes(r.id)) } : part;
  });
  if (parts.length === 0) fail("--merge pede os JSONs separados por vírgula.");
  const causes = value("causes") ? (JSON.parse(readFileSync(value("causes")!, "utf8")) as Record<string, string>) : {};
  const merged = mergeRuns(parts, TASKS.map((t) => t.id)).map((r) => (causes[r.id] ? { ...r, cause: causes[r.id] } : r));
  const excluded = merged.filter(isInfraFailure);
  const measured = merged.filter((r) => !isInfraFailure(r));
  const final = buildReport({ label, mode: parts[0].mode, startedAt: parts[0].startedAt, commit: parts[0].commit }, measured);
  const baselinePath = value("baseline");
  const base = baselinePath ? (JSON.parse(readFileSync(baselinePath, "utf8")) as BenchReport) : undefined;
  const md = `${renderMarkdown(TASKS, final, base)}

Fora das taxas (infraestrutura ou site, não do piloto): ${excluded.length > 0 ? excluded.map((r) => `${r.id}${r.cause ? ` — ${r.cause}` : ""}`).join("; ") : "nenhuma"}.
`;
  const outPath = value("out") ?? join("bench-results", `jev-bench-merge-${label}.json`);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ ...final, excluded: excluded.map((r) => r.id) }, null, 2)}
`);
  writeFileSync(outPath.replace(/\.json$/i, "") + ".md", md);
  console.log(md);
  process.exit(0);
}

// `--trend antes.json,depois.json,depois2.json --names ANTES,DEPOIS,DEPOIS2`: as rodadas lado a lado. Não roda nada.
if (flag("trend")) {
  const files = (value("trend") ?? "").split(",").filter(Boolean);
  const names = (value("names") ?? "").split(",");
  if (files.length === 0) fail("--trend pede os JSONs separados por vírgula.");
  const rounds = files.map((p, i) => ({ name: names[i] ?? `rodada ${i + 1}`, report: JSON.parse(readFileSync(p, "utf8")) as BenchReport }));
  console.log(renderTrend(TASKS, rounds));
  process.exit(0);
}

const mode: "sim" | "real" | null = flag("real") ? "real" : flag("sim") ? "sim" : null;
const only = value("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const port = intValue("port", 8765);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (flag("list")) {
  for (const task of value("set") === "teste" ? TEST_TASKS : TASKS) {
    console.log(`${task.id}  [${task.kind}${task.sim ? "+sim" : ""}${task.probe ? ", SONDA (fora dos portões)" : ""}${task.demoLogin ? ", login-demo" : ""}${(task.acts ?? 1) > 1 ? `, ${task.acts} act` : ""}] dif.${task.difficulty} ≤${task.maxSteps} passos`);
    console.log(`    ${task.title}`);
    console.log(`    objetivo: ${task.goal}`);
    console.log(`    sucesso:  ${describeCriterion(task.success)}${task.forbid ? ` · proibido: ${describeCriterion(task.forbid)}` : ""}`);
  }
  console.log(`\n${TASKS.length} tarefas (${TASKS.filter((t) => t.kind === "local").length} locais, ${TASKS.filter((t) => t.kind === "public").length} públicas; ${TASKS.filter((t) => t.probe).length} sondas fora dos portões).`);
  process.exit(0);
}
if (!mode && !flag("serve")) fail("Use --list, --sim, --real ou --serve. Veja o cabeçalho de scripts/jev-bench.ts.");


// ── Servidor das fixtures ───────────────────────────────────────────

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function serveFixtures(): Promise<Server> {
  const server = createServer((req, res) => {
    const [rawPath, rawSearch = ""] = (req.url ?? "/").split("?");
    const path = decodeURIComponent(rawPath);
    // `?delay=8000` (Fase 0.4): a resposta sai depois do atraso — vale para a página e para o XHR/fetch que ela faz.
    const delay = parseDelay(rawSearch);
    // `connection: close`: o proxy do app reaproveita conexões e acusa 502 quando o servidor as derruba (visto na 1.ª rodada real).
    const headers = (type: string) => ({ "content-type": type, "cache-control": "no-store", connection: "close" });
    const send = () => {
      // `/s?k=caneca&delay=8000`: a página de resultados renderizada no servidor, como a busca da Amazon (navegação lenta).
      if (path === "/s") { res.writeHead(200, headers(TYPES[".html"])).end(fixtureSearchPage(rawSearch)); return; }
      if (path.startsWith("/api/")) {
        const answer = fixtureApi(path, rawSearch);
        if (!answer) { res.writeHead(404, headers("text/plain; charset=utf-8")).end("não encontrado"); return; }
        res.writeHead(answer.status, headers("application/json; charset=utf-8")).end(JSON.stringify(answer.body));
        return;
      }
      const file = resolve(FIXTURES, `.${normalize(path === "/" ? "/index.html" : path)}`);
      if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404, headers("text/plain; charset=utf-8")).end("não encontrado"); return; }
      res.writeHead(200, headers(TYPES[extname(file)] ?? "application/octet-stream"));
      res.end(readFileSync(file));
    };
    // Qualquer resposta pode atrasar. As fixtures que buscam por fetch recebem o atraso do XHR em `?xhr=<ms>` (a página abre
    // na hora e repassa `delay=<ms>` à API), para o atraso cair na busca e não na abertura da página.
    if (delay > 0) setTimeout(send, delay);
    else send();
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

const set = value("set");
// `--set teste`: o conjunto de TESTE do protocolo J2 (100 tarefas geradas, fora das levas v1/v2 e dos números de sempre).
const selection = select(set === "teste" ? TEST_TASKS : set === "v1" || set === "v2" ? TASKS.filter((t) => (t.set ?? "v1") === set) : TASKS, {
  only, kind: undefined, includePublic: flag("public"), includeDemoLogin: flag("demo-login"), simOnly: mode === "sim",
});
if (selection.unknown.length > 0) fail(`Ids desconhecidos: ${selection.unknown.join(", ")} (use --list).`);
const repeat = intValue("repeat", 1);
const seedRaw = Number(value("seed") ?? "1");
const seed = Number.isFinite(seedRaw) ? Math.floor(seedRaw) : 1;
const alternate = !flag("no-alternate");
// Sem `--repeat` nem `--seed`, tudo como antes: ordem da lista e (no sim) latência fixa, comparável às rodadas antigas.
const seeded = repeat > 1 || value("seed") !== undefined;
const plan = seeded ? repetitionPlan(selection.run, repeat, seed, alternate) : [{ rep: 0, items: selection.run }];
const orderName = !seeded ? "da lista" : repeat > 1 && alternate ? "embaralhada por semente, invertida nas repetições ímpares" : "embaralhada por semente";
if (selection.run.length === 0) fail("Nenhuma tarefa selecionada.");
for (const s of selection.skipped) console.log(`(pulada ${s.id}: ${s.why})`);

// ── Modo real: o CLI `ags` ──────────────────────────────────────────

// `--cli <ags.exe>` (ou AGS_CLI) escolhe o CLI; o app vem do AGS_HANDSHAKE do ambiente.
const AGS = value("cli") ?? process.env.AGS_CLI ?? "ags";

// ASSÍNCRONO de propósito: o servidor das fixtures roda neste mesmo processo, e um `execFileSync` o travaria enquanto o app
// busca a página (foi o que derrubou a 1.ª rodada real: «A página não respondeu em 12 s»).
function ags(args: string[], timeoutMs = 150_000): Promise<string> {
  return new Promise((ok, err) => {
    execFile(AGS, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) err(Object.assign(error, { stdout, stderr }));
      else ok(unwrapCli(stdout));
    });
  });
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

/** Por que um comando do CLI falhou: a mensagem, a saída e o erro padrão (é onde o app diz «did not finish mounting»). */
function failure(e: unknown): string {
  const err = e as { message?: string; stdout?: string; stderr?: string };
  return [err.message, err.stdout, err.stderr].filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, 400);
}

/** O batimento de vários `act`: o pior lag, a soma de amostras/oculto/timeouts. */
function mergeWindows(parts: (WindowStats | null)[]): WindowStats | undefined {
  const seen = parts.filter((w): w is WindowStats => w !== null);
  if (seen.length === 0) return undefined;
  const max = (k: keyof WindowStats) => { const v = seen.map((w) => w[k]).filter((x): x is number => x !== undefined); return v.length > 0 ? Math.max(...v) : undefined; };
  const sum = (k: keyof WindowStats) => { const v = seen.map((w) => w[k]).filter((x): x is number => x !== undefined); return v.length > 0 ? v.reduce((a, b) => a + b, 0) : undefined; };
  const out: WindowStats = { lagMaxMs: max("lagMaxMs"), lagP95Ms: max("lagP95Ms"), samples: sum("samples"), hiddenMs: sum("hiddenMs"), timeouts: sum("timeouts") };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as WindowStats;
}

async function runRealTask(task: BenchTask, portal: string): Promise<TaskRun> {
  const crash = (note: string, partial: Partial<TaskRun> = {}): TaskRun => {
    const run: TaskRun = {
      id: task.id, outcome: "crash", criterionOk: false, forbidden: false, steps: 0, autoFills: 0, photos: 0, totalMs: 0,
      stepMs: [], phases: emptyPhases(), timing: "reported", finalUrl: "", ...partial, note: note.slice(0, 400),
    };
    return { ...run, windowHang: isWindowHang(run) };
  };
  try {
    await ags(["portal", "navigate", portal, absolute(task)], 60_000);
    // Cada rodada começa do zero (J1): sem isto o estado do site (o carrinho da SauceDemo) e o livro-razão dos `act` vinham
    // da rodada anterior e a tarefa medida era outra. `--no-reset` volta ao comportamento antigo, para comparar.
    if (!flag("no-reset")) {
      await ags(["portal", "reset", portal], 60_000);
      await ags(["portal", "navigate", portal, absolute(task)], 60_000);
    }
  } catch (e) {
    return crash(`navegar falhou: ${failure(e)}`);
  }
  const args = ["portal", "act", portal, task.goal, ...(task.fills ?? []).flatMap((f) => ["--fill", f]), ...(flag("with-expect") ? expectsFor(task.success).flatMap((e) => ["--expect", e]) : []), "--steps", String(task.maxSteps)];
  // Vários `act` com o mesmo objetivo (N10): o agente que repete; o critério é contado depois do último.
  const acts = Math.max(1, task.acts ?? 1);
  const actMs: number[] = [];
  const stepMs: number[] = [];
  const queries: QueryStats[] = [];
  const windows: (WindowStats | null)[] = [];
  const phases: Phases = emptyPhases();
  const texts: string[] = [];
  let probes: number | undefined;
  let steps = 0;
  let autoFills = 0;
  let photos = 0;
  let blocked = false;
  let report: ReturnType<typeof parseActReport> | null = null;
  for (let a = 0; a < acts; a++) {
    const started = performance.now();
    let text: string;
    try {
      text = await ags(args, 150_000);
    } catch (e) {
      return crash(`act ${a + 1}/${acts} falhou: ${failure(e)}`, { acts: a + 1, actMs, stepMs, steps });
    }
    const totalMs = Math.round(performance.now() - started);
    report = parseActReport(text);
    texts.push(text);
    actMs.push(totalMs);
    // O relatório do act traz a linha TEMPOS (somas por fase) e o tempo de cada passo que agiu; o que sobra do relógio de
    // quem rodou vira «outros». Sem o tempo de passo (relatório antigo), vale a média.
    const split = phasesFromReport(report, totalMs);
    for (const key of Object.keys(phases) as (keyof Phases)[]) phases[key] += split.phases[key];
    if (split.probes !== undefined) probes = (probes ?? 0) + split.probes;
    const perStep = report.steps > 0 ? totalMs / report.steps : totalMs;
    stepMs.push(...(report.stepMs.length > 0 ? report.stepMs : Array.from({ length: Math.max(1, report.steps) }, () => perStep)));
    queries.push(queriesFromReport(report));
    windows.push(report.window);
    steps += report.steps;
    autoFills += report.autoFills;
    photos += report.photos;
    blocked ||= report.blocked;
  }
  let finalSnapshot = report!.finalSnapshot;
  try { finalSnapshot = await ags(["portal", "snapshot", portal], 60_000); } catch { /* fica com a página embutida no relatório */ }
  let evaluated = evaluate(task, finalSnapshot);
  // Página com XHR (N03/N04/N09…): o critério tem de continuar valendo com a página assentada.
  if (task.settleMs) {
    await new Promise((ok) => setTimeout(ok, task.settleMs));
    try {
      const later = evaluate(task, await ags(["portal", "snapshot", portal], 60_000));
      evaluated = { criterionOk: evaluated.criterionOk && later.criterionOk, forbidden: evaluated.forbidden || later.forbidden, finalUrl: later.finalUrl };
    } catch { /* sem a 2.ª leitura, vale a primeira */ }
  }
  const window = mergeWindows(windows);
  const run: TaskRun = {
    id: task.id, outcome: report!.outcome ?? "crash", ...evaluated,
    steps, autoFills, photos, totalMs: actMs.reduce((x, y) => x + y, 0), stepMs,
    phases, timing: "reported", blocked, ...(report!.verdict ? { verdict: report!.verdict } : {}), report: texts.join("\n\n").slice(0, 5000), ...(probes !== undefined ? { probes } : {}),
    acts, actMs, queries: mergeQueries(queries), ...(window ? { window } : {}),
    ...(report!.outcome === null ? { note: "relatório do act não reconhecido" } : {}),
  };
  return { ...run, windowHang: isWindowHang(run) };
}

// ── Execução ────────────────────────────────────────────────────────

function commit(): string | undefined {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return undefined; }
}

const runs: TaskRun[] = [];
const startedAt = new Date().toISOString();
let server: Server | null = null;

const tag = (rep: number) => (repeat > 1 ? ` [rep ${rep + 1}/${repeat}]` : "");

if (mode === "sim") {
  for (const { rep, items } of plan) {
    for (const [order, task] of items.entries()) {
      // A semente da latência é por tarefa e repetição (não pela posição): a ordem não muda os números do sim.
      const run = { ...(await runSimTask(task, { visual: !flag("no-visual"), guard: flag("sim-guard"), withExpect: flag("with-expect"), ...(seeded ? { seed: hashSeed(seed, task.id, rep) } : {}) })), rep, order };
      runs.push(run);
      console.log(`${run.criterionOk && !run.forbidden ? "ok  " : "FALHA"} ${task.id}${tag(rep)} — ${run.outcome}, ${run.steps} passos, ${(run.totalMs / 1000).toFixed(1)} s virtuais`);
      if (flag("verbose")) for (const line of [...(run.log ?? []), ...(run.note ? [`nota: ${run.note}`] : [])]) console.log(`      ${line}`);
    }
  }
} else {
  const budget = { maxTasks: intValue("max-real", 5), maxProbes: intValue("max-probes", 60) };
  const planned: { task: BenchTask; rep: number; order: number }[] = [];
  let worst = 0;
  planning: for (const { rep, items } of plan) {
    for (const [order, task] of items.entries()) {
      // O pior caso conta cada `act`: N10 gasta até 2 × maxSteps.
      const cost = { maxSteps: task.maxSteps * Math.max(1, task.acts ?? 1) };
      const verdict = canStart(budget, planned.length, worst, cost);
      if (!verdict.ok) { console.log(`(parou de planejar em ${task.id}${tag(rep)}: ${verdict.why})`); break planning; }
      planned.push({ task, rep, order });
      worst += cost.maxSteps;
    }
  }
  if (planned.length === 0) fail("O teto não deixa rodar nenhuma tarefa: aumente --max-probes.");
  await confirmReal(planned.map((p) => p.task), budget.maxProbes);
  server = await serveFixtures();
  let portal = value("portal") ?? `bench-jev-${Date.now().toString(36)}`;
  if (!value("portal")) {
    try {
      // O app pode renomear (`bench-jev 2`) se o nome já existe: vale o nome que ele devolve.
      const made = await ags(["portal", "create", portal, absolute(planned[0].task)], 60_000);
      try { const name = (JSON.parse(made) as { created?: { name?: unknown } }).created?.name; if (typeof name === "string" && name) portal = name; } catch { /* texto puro: fica o nome pedido */ }
    } catch (e) { server.close(); fail(`Não consegui criar o portal (rode num terminal de agente do app): ${e instanceof Error ? e.message : String(e)}`); }
  }
  let used = 0;
  for (const { task, rep, order } of planned) {
    // Já aconteceu de o canvas perder os portais no meio da rodada («não está conectado com você»): confere antes de cada
    // tarefa e, se o portal sumiu, cria outro (só quando o runner o criou; com --portal o nome é de quem pediu).
    if (!value("portal")) {
      try {
        const listed = JSON.parse(await ags(["portals"], 30_000)) as { portals?: { name?: unknown }[] };
        if (!listed.portals?.some((p) => p.name === portal)) {
          const made = await ags(["portal", "create", `${portal}-r`, absolute(task)], 60_000);
          const name = (JSON.parse(made) as { created?: { name?: unknown } }).created?.name;
          if (typeof name === "string" && name) { console.log(`(o portal ${portal} sumiu; criei ${name})`); portal = name; }
        }
      } catch { /* sem a conferência a tarefa tenta mesmo assim, e o guarda de infraestrutura cuida do resto */ }
    }
    const run = { ...(await runRealTask(task, portal)), rep, order };
    runs.push(run);
    used += run.outcome === "crash" ? 0 : run.probes ?? Math.max(run.steps + run.photos, 1);
    console.log(`${run.criterionOk && !run.forbidden ? "ok  " : "FALHA"} ${task.id}${tag(rep)} — ${run.outcome}, ${run.steps} passos, ${(run.totalMs / 1000).toFixed(1)} s (${used} sondas até aqui)${isInfraFailure(run) ? " [infra]" : ""}${run.windowHang ? " [janela travou]" : ""}`);
    if (infraTooHigh(runs)) { console.log(`
PARADO: mais de 30% das rodadas falharam por infraestrutura (${runs.filter(isInfraFailure).length}/${runs.length}). Nada mais gastou cota.`); break; }
  }
  server.close();
}

const report: BenchReport = buildReport({ label, mode, startedAt, commit: commit(), seed, repeat, order: orderName }, runs, TASKS);
let baseline: BenchReport | undefined;
const comparePath = value("compare");
if (comparePath) {
  try { baseline = JSON.parse(readFileSync(comparePath, "utf8")) as BenchReport; } catch (e) { fail(`--compare ilegível (${comparePath}): ${e instanceof Error ? e.message : String(e)}`); }
}
const markdown = renderMarkdown(TASKS, report, baseline);
const out = value("out") ?? join("bench-results", `jev-bench-${mode}-${label}.json`);
const write = (path: string) => {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.replace(/\.json$/i, "") + ".md", `${markdown}\n`);
};
write(out);
const mdPath = out.replace(/\.json$/i, "") + ".md";
// `--history`: um JSON (e o .md) por rodada em docs/ade-ags/bench/historico/, e uma linha no índice HISTORICO.md.
if (flag("history")) {
  const dir = join(here, "..", "docs", "ade-ags", "bench", "historico");
  const stamp = startedAt.replace(/[:]/g, "").replace(/\..*$/, "");
  const slug = label.replace(/[^\w.-]+/g, "-");
  const historyPath = join(dir, `${stamp}-${mode}-${slug}.json`);
  write(historyPath);
  const index = join(dir, "HISTORICO.md");
  const g = report.v2!.gate;
  const head = "# Histórico do benchmark do piloto do Jev\n\nUma linha por rodada gravada com `--history` (o JSON e o .md ao lado). Taxas do **portão** (sem sondas).\n\n| data | rótulo | modo | commit | semente | rep. | sucesso | falso feito | falso parou | passo p50 · p95 | impressão | arquivo |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  const line = `| ${startedAt} | ${label} | ${mode} | ${report.commit ?? "—"} | ${seed} | ${repeat} | ${g.successes}/${g.runs} | ${g.falseDone} | ${g.falseStop} | ${Math.round(g.stepP50)} · ${Math.round(g.stepP95)} ms | \`${report.digest}\` | ${historyPath.split(/[\\/]/).pop()} |\n`;
  writeFileSync(index, `${existsSync(index) ? readFileSync(index, "utf8") : head}${line}`);
  console.log(`Histórico: ${historyPath}`);
}
console.log(`\n${markdown}\n\nJSON: ${out}\nMarkdown: ${mdPath}\nImpressão dos números: ${report.digest}`);
// `--gate`: o portão de liberação (Fase 7). Sai com código 1 se algum limite falhar.
if (flag("gate")) {
  const gate = gateCheck(report.v2!.gate);
  console.log(gate.ok ? "\nPORTÃO: passou." : `\nPORTÃO: REPROVADO — ${gate.failures.join("; ")}.`);
  process.exit(gate.ok ? 0 : 1);
}
process.exit(0);
