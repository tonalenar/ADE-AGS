/**
 * Lógica PURA do benchmark do piloto do Jev (`scripts/jev-bench.ts`): critérios de sucesso verificáveis pela página,
 * classificação de cada rodada, relógio e fases de tempo, agregação de métricas, leitura do relatório do
 * `ags portal act` e as tabelas em Markdown. Nada aqui toca rede, disco ou navegador: é o que o vitest cobre.
 */
import { parseSnapshot, type PilotDeps, type PilotResult } from "../../src/features/browser/jevPilot";

// ── Critérios de sucesso ────────────────────────────────────────────

/** Um critério lê só a página (endereço + texto do `snapshot`); nunca o que o piloto disse. */
export type Criterion =
  | { kind: "urlIncludes"; value: string }
  | { kind: "text"; value: string }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "not"; of: Criterion }
  | { kind: "all"; of: Criterion[] }
  | { kind: "any"; of: Criterion[] };

export const url = (value: string): Criterion => ({ kind: "urlIncludes", value });
export const text = (value: string): Criterion => ({ kind: "text", value });
export const regex = (pattern: string, flags = "i"): Criterion => ({ kind: "regex", pattern, flags });
export const not = (of: Criterion): Criterion => ({ kind: "not", of });
export const all = (...of: Criterion[]): Criterion => ({ kind: "all", of });
export const any = (...of: Criterion[]): Criterion => ({ kind: "any", of });

/** Minúsculas, sem acento, espaços colapsados: "Garantia  ABERTA" casa com "garantia aberta". */
export function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** O que um critério enxerga da página. */
export interface PageView {
  url: string;
  /** O corpo do `snapshot` (nomes dos elementos e texto visível), já dobrado por `fold`. */
  body: string;
  /** O mesmo corpo, sem dobrar: para as expressões regulares. */
  raw: string;
}

/** Lê o texto do `snapshot` numa `PageView`. Pura. */
export function viewOf(snapshot: string): PageView {
  const page = parseSnapshot(snapshot);
  const raw = snapshot.split("\n").filter((line) => !/^(page|viewport): /.test(line)).join("\n");
  return { url: page.url, body: fold(raw), raw };
}

export function check(criterion: Criterion, view: PageView): boolean {
  switch (criterion.kind) {
    case "urlIncludes": return view.url.toLowerCase().includes(criterion.value.toLowerCase());
    case "text": return view.body.includes(fold(criterion.value));
    case "regex": return new RegExp(criterion.pattern, criterion.flags ?? "i").test(view.raw);
    case "not": return !check(criterion.of, view);
    case "all": return criterion.of.every((c) => check(c, view));
    case "any": return criterion.of.some((c) => check(c, view));
  }
}

/** Um critério em uma frase, para a tabela e a lista de tarefas. */
export function describeCriterion(criterion: Criterion): string {
  switch (criterion.kind) {
    case "urlIncludes": return `URL contém \`${criterion.value}\``;
    case "text": return `texto «${criterion.value}»`;
    case "regex": return `texto /${criterion.pattern}/`;
    case "not": return `não (${describeCriterion(criterion.of)})`;
    case "all": return criterion.of.map(describeCriterion).join(" e ");
    case "any": return `(${criterion.of.map(describeCriterion).join(" ou ")})`;
  }
}

// ── Tarefas ─────────────────────────────────────────────────────────

export interface BenchTask {
  id: string;
  /** Uma linha para a tabela. */
  title: string;
  /** O objetivo, em PT-BR, como o agente o passaria ao `ags portal act`. */
  goal: string;
  /** Caminho em `scripts/bench-fixture/` (`/icones.html`) ou URL absoluta. */
  url: string;
  /** `campo=valor`, só dados fictícios (ou os de demonstração que o próprio site publica). */
  fills?: string[];
  /** Limite de passos (o piloto aceita até 15). */
  maxSteps: number;
  /** Cumprido ⇒ a tarefa foi concluída. */
  success: Criterion;
  /** Se isto valer ao final, o piloto fez o que não devia (comprou, finalizou…): conta como violação. */
  forbid?: Criterion;
  /** 1 (fácil) a 5 (difícil). */
  difficulty: 1 | 2 | 3 | 4 | 5;
  kind: "local" | "public";
  /** O que a tarefa exercita (`icone-sem-nome`, `enter`, `modal`…). */
  tags: string[];
  /** Tem página simulada em `scripts/bench/sim.ts`. */
  sim: boolean;
  /** Pede o login de demonstração do próprio site: só roda com `--demo-login`. */
  demoLogin?: boolean;
  /** Para quem lê o relatório: o que se espera ou o que a torna frágil. */
  note?: string;
}

// ── Relógio e fases ─────────────────────────────────────────────────

export interface Clock {
  now: () => number;
}

/** As fases em que o tempo de um passo se divide. `other` = o que sobrou (processos, rede do CLI). */
export interface Phases {
  /** Consulta ao Jev (operação+elemento, e a da foto). */
  jevMs: number;
  snapshotMs: number;
  /** Clicar, digitar, escolher, rolar. */
  actionMs: number;
  /** Esperar a página assentar. */
  waitMs: number;
  otherMs: number;
}

export const emptyPhases = (): Phases => ({ jevMs: 0, snapshotMs: 0, actionMs: 0, waitMs: 0, otherMs: 0 });

export interface Timings {
  phases: Phases;
  /** Quanto durou cada passo (da consulta ao Jev à seguinte). */
  stepMs: number[];
  /** Quantas consultas ao Jev e quantas fotos. */
  picks: number;
  photos: number;
  totalMs: number;
}

/**
 * Embrulha as ações do piloto para medir cada fase. O passo vai de uma consulta ao Jev à seguinte: o primeiro inclui
 * o primeiro `snapshot`, o último termina quando o piloto devolve. Pura salvo o `clock`.
 */
export function instrument(deps: PilotDeps, clock: Clock): { deps: PilotDeps; finish: () => Timings } {
  const phases = emptyPhases();
  const started = clock.now();
  const boundaries: number[] = [started];
  let picks = 0;
  let photos = 0;
  const timed = async <T>(phase: keyof Phases, fn: () => Promise<T>): Promise<T> => {
    const at = clock.now();
    try {
      return await fn();
    } finally {
      phases[phase] += clock.now() - at;
    }
  };
  const wrapped: PilotDeps = {
    snapshot: () => timed("snapshotMs", () => deps.snapshot()),
    click: (ref, navigates) => timed("actionMs", () => deps.click(ref, navigates)),
    type: (ref, value, submit) => timed("actionMs", () => deps.type(ref, value, submit)),
    select: (ref, value) => timed("actionMs", () => deps.select(ref, value)),
    scroll: () => timed("actionMs", () => deps.scroll()),
    settle: (thorough) => timed("waitMs", () => deps.settle(thorough)),
    pick: (query) => {
      picks += 1;
      if (picks > 1) boundaries.push(clock.now());
      return timed("jevMs", () => deps.pick(query));
    },
    ...(deps.visual ? { visual: (goal: string, recent: string) => { photos += 1; return timed("jevMs", () => deps.visual!(goal, recent)); } } : {}),
    ...(deps.peekAt ? { peekAt: (x: number, y: number) => timed("actionMs", () => deps.peekAt!(x, y)) } : {}),
    ...(deps.clickAt ? { clickAt: (x: number, y: number) => timed("actionMs", () => deps.clickAt!(x, y)) } : {}),
  };
  return {
    deps: wrapped,
    finish: () => {
      const end = clock.now();
      boundaries.push(end);
      const stepMs = boundaries.slice(1).map((at, i) => at - boundaries[i]);
      const totalMs = end - started;
      phases.otherMs = Math.max(0, totalMs - phases.jevMs - phases.snapshotMs - phases.actionMs - phases.waitMs);
      return { phases: { ...phases }, stepMs, picks, photos, totalMs };
    },
  };
}

// ── Uma rodada ──────────────────────────────────────────────────────

export type Outcome = PilotResult["outcome"] | "crash";

export interface TaskRun {
  id: string;
  outcome: Outcome;
  /** O critério de sucesso vale na página final. */
  criterionOk: boolean;
  /** O critério proibido vale na página final (comprou, finalizou…). */
  forbidden: boolean;
  /** Passos numerados do relatório do piloto (não conta os campos preenchidos pelo nome). */
  steps: number;
  autoFills: number;
  photos: number;
  totalMs: number;
  /** Tempo de cada passo; em `estimated`, só a média (total ÷ passos). */
  stepMs: number[];
  phases: Phases;
  /** `measured` = o piloto foi medido por dentro (sim); `reported` = só o que o relatório do act traz (real). */
  timing: "measured" | "reported";
  finalUrl: string;
  note?: string;
  /** O relatório de passos do piloto (só no sim; o real traz o texto do act). */
  log?: string[];
  /** O piloto recusou um controle de compra/pagamento que o objetivo não pediu (`blockedPurchase`). */
  blocked?: boolean;
  /** Consultas ao Jev (operação+elemento) e fotos que a rodada gastou: a cota. */
  probes?: number;
  /** A causa da falha, classificada à mão a partir do relatório do act (`--causes`). */
  cause?: string;
  /** O relatório do `act` como veio (só no real, cortado): serve para classificar a causa de uma falha. */
  report?: string;
}

export interface Verdict {
  /** Cumpriu o critério e não fez o proibido: o que conta como "concluída sem ajuda à mão". */
  completed: boolean;
  /** Disse "concluído" mas o critério falhou (ou fez o proibido). */
  falseDone: boolean;
  /** O critério já valia, mas parou dizendo que não tinha certeza (ou sem caminho). */
  falseUnsure: boolean;
  /** Fez o que a tarefa proíbe. */
  violation: boolean;
}

export function judge(run: Pick<TaskRun, "outcome" | "criterionOk" | "forbidden">): Verdict {
  const completed = run.criterionOk && !run.forbidden;
  return {
    completed,
    falseDone: run.outcome === "done" && !completed,
    falseUnsure: (run.outcome === "unsure" || run.outcome === "stuck") && completed,
    violation: run.forbidden,
  };
}

/** Avalia a página final de uma tarefa. Pura. */
export function evaluate(task: Pick<BenchTask, "success" | "forbid">, finalSnapshot: string): { criterionOk: boolean; forbidden: boolean; finalUrl: string } {
  const view = viewOf(finalSnapshot);
  return { criterionOk: check(task.success, view), forbidden: task.forbid ? check(task.forbid, view) : false, finalUrl: view.url };
}

/**
 * O CLI `ags portal …` devolve JSON (`{"portal":{…},"text":"…"}`): o texto que interessa (o relatório do act, o snapshot)
 * vem em `text`. Sem JSON de objeto com `text` string, devolve a saída como veio. Pura.
 */
export function unwrapCli(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { text?: unknown }).text === "string") return (parsed as { text: string }).text;
  } catch { /* não era JSON: fica como veio */ }
  return raw;
}

// ── Relatório do `ags portal act` ───────────────────────────────────

export interface ActReport {
  outcome: PilotResult["outcome"] | null;
  steps: number;
  autoFills: number;
  photos: number;
  /** A soma dos "NNN ms" da consulta ao Jev que o relatório traz em cada passo. */
  jevMs: number;
  /** O tempo de cada passo que agiu ("passo NNN ms", desde 8cd9db5c). Vazio num relatório antigo. */
  stepMs: number[];
  /** A linha `TEMPOS: {json}` do relatório (somas por fase em ms, desde 4ab17b3b). `null` num relatório antigo. */
  timings: ReportTimings | null;
  /** O piloto recusou uma compra/pagamento que o objetivo não pediu. */
  blocked: boolean;
  /** A página final embutida no relatório (pode vir cortada em 6000 caracteres). */
  finalSnapshot: string;
}

/** O que o `runPilot` mede por dentro (`Timings` em `jevPilot.ts`). */
export interface ReportTimings {
  jev: number;
  snapshot: number;
  acao: number;
  espera: number;
  foto: number;
  consultas: number;
  fotos: number;
  total: number;
}

const TIMING_KEYS: (keyof ReportTimings)[] = ["jev", "snapshot", "acao", "espera", "foto", "consultas", "fotos", "total"];

/** A linha `TEMPOS: {...}`; ignora o que não for um objeto com todos os números. Pura. */
export function parseTimings(line: string): ReportTimings | null {
  if (!line.startsWith("TEMPOS: ")) return null;
  try {
    const raw: unknown = JSON.parse(line.slice("TEMPOS: ".length));
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (!TIMING_KEYS.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))) return null;
    return Object.fromEntries(TIMING_KEYS.map((key) => [key, record[key] as number])) as unknown as ReportTimings;
  } catch {
    return null;
  }
}

const HEADS: [string, PilotResult["outcome"]][] = [
  ["PAROU (Jev sem certeza)", "unsure"], ["PAROU", "stuck"], ["FEITO", "done"], ["NÃO RODOU", "off"], ["LIMITE DE PASSOS", "limit"], ["ERRO", "error"],
];
const FINAL_MARK = "A página agora (o Jev só escolhe onde tocar: confira o resultado):";

/** Lê o texto que o `act` devolve (ver `formatResult` em `jevPilot.ts`). Pura. */
export function parseActReport(report: string): ActReport {
  const lines = report.split("\n");
  const head = lines[0] ?? "";
  const outcome = HEADS.find(([label]) => head.endsWith(`: ${label}`))?.[1] ?? null;
  const at = lines.indexOf(FINAL_MARK);
  const stepLines = lines.slice(0, at === -1 ? lines.length : at);
  let steps = 0;
  let autoFills = 0;
  let photos = 0;
  let jevMs = 0;
  const stepMs: number[] = [];
  let blocked = false;
  let timings: ReportTimings | null = null;
  for (const line of stepLines) {
    timings ??= parseTimings(line);
    // `recusou …` (clique) ou `… compra ou pagamento … não toquei/não cliquei` (foto, nota): a trava `blockedPurchase`.
    if (/recusou |compra ou (um )?pagamento/.test(line)) blocked = true;
    if (/^\d+\. /.test(line)) steps += 1;
    if (line.includes("sem o Jev)")) autoFills += 1;
    if (line.includes("tocou pela foto")) photos += 1;
    // `(p=0.95, fim p=0.10, 450 ms, passo 900 ms)`: o 1.º «ms» é a consulta ao Jev; o «passo» é o passo inteiro.
    const ms = /, (\d+) ms(?:,|\))/.exec(line);
    if (ms) jevMs += Number(ms[1]);
    const whole = /passo (\d+) ms\)/.exec(line);
    if (whole) stepMs.push(Number(whole[1]));
  }
  return { outcome, steps, autoFills, photos, jevMs, stepMs, timings, blocked, finalSnapshot: at === -1 ? "" : lines.slice(at + 1).join("\n") };
}

/**
 * As fases de uma rodada REAL a partir do relatório do act. Com a linha `TEMPOS` há a divisão inteira (a foto soma à
 * consulta ao Jev); sem ela, só a consulta ao Jev (dos «NNN ms» dos passos). O que o relatório não cobre (o CLI, a
 * viagem ao app) é `otherMs`: parte de `totalMs`, o relógio de quem rodou. Pura.
 */
export function phasesFromReport(report: Pick<ActReport, "jevMs" | "timings">, totalMs: number): { phases: Phases; probes: number | undefined } {
  const t = report.timings;
  if (!t) {
    const jevMs = Math.min(report.jevMs, totalMs);
    return { phases: { ...emptyPhases(), jevMs, otherMs: totalMs - jevMs }, probes: undefined };
  }
  const jevMs = t.jev + t.foto;
  return {
    phases: { jevMs, snapshotMs: t.snapshot, actionMs: t.acao, waitMs: t.espera, otherMs: Math.max(0, totalMs - jevMs - t.snapshot - t.acao - t.espera) },
    probes: t.consultas + t.fotos,
  };
}

/**
 * A rodada falhou por INFRAESTRUTURA (o app, o portal, o CLI), não pelo piloto? `crash` (o comando falhou), `off` (o Jev
 * desligado, nada rodou) e um `error` cujo texto fala de montagem do canvas ou de tempo esgotado. Pura.
 */
export function isInfraFailure(run: Pick<TaskRun, "outcome" | "note" | "report">): boolean {
  if (run.outcome === "crash" || run.outcome === "off") return true;
  return run.outcome === "error" && /did not finish mounting|timed? ?out|tempo esgotado|n[ãa]o tem nenhuma p[áa]gina|no page loaded/i.test(`${run.note ?? ""}
${run.report ?? ""}`);
}

/** Passou do teto de falhas de infraestrutura? Só vale depois de `minTasks` rodadas (uma falha em duas não é taxa). Pura. */
export function infraTooHigh(runs: Pick<TaskRun, "outcome" | "note" | "report">[], maxRate = 0.3, minTasks = 4): boolean {
  return runs.length >= minTasks && runs.filter(isInfraFailure).length / runs.length > maxRate;
}

// ── Agregação ───────────────────────────────────────────────────────

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export interface Summary {
  tasks: number;
  completed: number;
  completedRate: number;
  /** Concluídas E confirmadas pelo piloto (`done`): o critério vale e ele não pediu ajuda. */
  confirmed: number;
  falseDone: number;
  falseUnsure: number;
  violations: number;
  /** Rodadas em que o piloto recusou uma compra/pagamento não pedido. */
  blocked: number;
  meanSteps: number;
  medianSteps: number;
  medianTotalMs: number;
  /** A mediana de TODOS os passos de TODAS as tarefas. */
  medianStepMs: number;
  /** Fatia de cada fase no tempo total (soma 1; 0 quando não há tempo). */
  share: Record<keyof Phases, number>;
  /** Por desfecho do piloto. */
  outcomes: Partial<Record<Outcome, number>>;
}

export function summarize(runs: TaskRun[]): Summary {
  const verdicts = runs.map(judge);
  const completed = verdicts.filter((v) => v.completed).length;
  const total = runs.reduce((sum, r) => sum + r.totalMs, 0);
  const phase = (key: keyof Phases) => runs.reduce((sum, r) => sum + r.phases[key], 0);
  const share = (key: keyof Phases) => (total > 0 ? phase(key) / total : 0);
  const outcomes: Partial<Record<Outcome, number>> = {};
  for (const run of runs) outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;
  return {
    tasks: runs.length,
    completed,
    completedRate: runs.length > 0 ? completed / runs.length : 0,
    confirmed: runs.filter((r) => judge(r).completed && r.outcome === "done").length,
    falseDone: verdicts.filter((v) => v.falseDone).length,
    falseUnsure: verdicts.filter((v) => v.falseUnsure).length,
    violations: verdicts.filter((v) => v.violation).length,
    blocked: runs.filter((r) => r.blocked).length,
    meanSteps: mean(runs.map((r) => r.steps)),
    medianSteps: median(runs.map((r) => r.steps)),
    medianTotalMs: median(runs.map((r) => r.totalMs)),
    medianStepMs: median(runs.flatMap((r) => r.stepMs)),
    share: { jevMs: share("jevMs"), snapshotMs: share("snapshotMs"), actionMs: share("actionMs"), waitMs: share("waitMs"), otherMs: share("otherMs") },
    outcomes,
  };
}

// ── Relatório ───────────────────────────────────────────────────────

export interface BenchReport {
  schema: 1;
  label: string;
  mode: "sim" | "real";
  startedAt: string;
  commit?: string;
  runs: TaskRun[];
  summary: Summary;
}

export function buildReport(meta: Pick<BenchReport, "label" | "mode" | "startedAt" | "commit">, runs: TaskRun[]): BenchReport {
  return { schema: 1, ...meta, runs, summary: summarize(runs) };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const ms0 = (ms: number) => `${Math.round(ms)} ms`;

function mark(run: TaskRun): string {
  const v = judge(run);
  if (v.violation) return "⛔ violação";
  if (run.blocked && !v.completed) return "🛡️ barrado";
  if (v.completed) return run.outcome === "done" ? "✅" : `✅ (${run.outcome})`;
  if (v.falseDone) return "❌ falso concluído";
  if (v.falseUnsure) return "❌ falso sem certeza";
  return `❌ ${run.outcome}`;
}

/** A tabela por tarefa. Com `baseline`, acrescenta a coluna ANTES (a deste relatório vira DEPOIS). Pura. */
export function renderTaskTable(tasks: BenchTask[], report: BenchReport, baseline?: BenchReport): string {
  const byId = (r: BenchReport | undefined) => new Map((r?.runs ?? []).map((run) => [run.id, run]));
  const now = byId(report);
  const before = byId(baseline);
  const head = baseline
    ? "| id | tarefa | dif. | ANTES | DEPOIS | passos (antes → depois) | tempo (antes → depois) |\n|---|---|---|---|---|---|---|"
    : "| id | tarefa | dif. | resultado | passos | tempo | mediana/passo |\n|---|---|---|---|---|---|---|";
  const rows = tasks.filter((t) => now.has(t.id) || before.has(t.id)).map((task) => {
    const a = before.get(task.id);
    const b = now.get(task.id);
    if (baseline) {
      return `| ${task.id} | ${task.title} | ${task.difficulty} | ${a ? mark(a) : "—"} | ${b ? mark(b) : "—"} | ${a ? a.steps : "—"} → ${b ? b.steps : "—"} | ${a ? secs(a.totalMs) : "—"} → ${b ? secs(b.totalMs) : "—"} |`;
    }
    const run = b!;
    return `| ${task.id} | ${task.title} | ${task.difficulty} | ${mark(run)} | ${run.steps} | ${secs(run.totalMs)} | ${ms0(median(run.stepMs))}${run.timing === "reported" ? " (média)" : ""} |`;
  });
  return [head, ...rows].join("\n");
}

/** As taxas e os tempos agregados; com `baseline`, o ANTES ao lado. Pura. */
export function renderSummary(report: BenchReport, baseline?: BenchReport): string {
  const s = report.summary;
  const b = baseline?.summary;
  const rows: [string, (x: Summary) => string][] = [
    ["tarefas", (x) => String(x.tasks)],
    ["concluídas sem ajuda à mão (critério vale na página)", (x) => `${x.completed}/${x.tasks} (${pct(x.completedRate)})`],
    ["… e o piloto confirmou (`done`)", (x) => (x.confirmed === undefined ? "—" : `${x.confirmed}/${x.tasks}`)],
    ["falso «concluído»", (x) => String(x.falseDone)],
    ["falso «sem certeza»", (x) => String(x.falseUnsure)],
    ["violações (comprou/finalizou)", (x) => String(x.violations)],
    ["compras não pedidas barradas pelo piloto", (x) => String(x.blocked ?? 0)],
    ["passos (média · mediana)", (x) => `${x.meanSteps.toFixed(1)} · ${x.medianSteps}`],
    ["tempo total (mediana)", (x) => secs(x.medianTotalMs)],
    ["tempo por passo (mediana)", (x) => ms0(x.medianStepMs)],
    ["tempo: consulta ao Jev", (x) => pct(x.share.jevMs)],
    ["tempo: snapshot", (x) => pct(x.share.snapshotMs)],
    ["tempo: ação", (x) => pct(x.share.actionMs)],
    ["tempo: espera", (x) => pct(x.share.waitMs)],
    ["tempo: outros/não medido", (x) => pct(x.share.otherMs)],
  ];
  const head = b ? "| métrica | ANTES | DEPOIS |\n|---|---|---|" : "| métrica | valor |\n|---|---|";
  return [head, ...rows.map(([label, f]) => (b ? `| ${label} | ${f(b)} | ${f(s)} |` : `| ${label} | ${f(s)} |`))].join("\n");
}

/** As tarefas que falharam, com a causa provável pela classe de falha. Pura. */
export function renderFailures(tasks: BenchTask[], report: BenchReport): string {
  const lines = report.runs.filter((r) => !judge(r).completed || judge(r).falseUnsure).map((run) => {
    const task = tasks.find((t) => t.id === run.id);
    const v = judge(run);
    const why = v.violation ? "fez o que a tarefa proíbe" : run.blocked ? "o piloto recusou um controle de compra/pagamento (seguro, mas não concluiu)" : v.falseDone ? "disse concluído sem cumprir o critério" : run.outcome === "limit" ? "estourou o limite de passos" : `parou: ${run.outcome}`;
    const late = judge(run).completed ? "o critério já valia, mas o piloto parou sem confirmar" : why;
    return `- **${run.id}** (${task?.title ?? "?"}) — ${late}${run.cause ? `. **Causa:** ${run.cause}` : ""}${!run.cause && task?.note ? `. ${task.note}` : ""}${run.note ? ` [${run.note}]` : ""}`;
  });
  return lines.length > 0 ? lines.join("\n") : "Nenhuma.";
}

/**
 * Junta rodadas parciais numa só: para cada tarefa vale a ÚLTIMA rodada que a trouxe (uma tarefa refeita por falha de
 * infraestrutura substitui a anterior). A ordem final é a de `order`. Pura.
 */
export function mergeRuns(reports: Pick<BenchReport, "runs">[], order: string[]): TaskRun[] {
  const byId = new Map<string, TaskRun>();
  for (const report of reports) for (const run of report.runs) byId.set(run.id, run);
  return order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

export function renderMarkdown(tasks: BenchTask[], report: BenchReport, baseline?: BenchReport): string {
  return [
    `### ${report.label} — modo ${report.mode}${report.commit ? ` · ${report.commit}` : ""} · ${report.startedAt}`,
    "",
    renderSummary(report, baseline),
    "",
    renderTaskTable(tasks, report, baseline),
    "",
    "Falhas:",
    renderFailures(tasks, report),
  ].join("\n");
}

// ── Seleção ─────────────────────────────────────────────────────────

export interface Selection {
  only?: string[];
  kind?: "local" | "public";
  /** Inclui as tarefas públicas (rede, sites de terceiros). */
  includePublic: boolean;
  /** Inclui as que pedem o login de demonstração do site. */
  includeDemoLogin: boolean;
  /** Só as que têm página simulada. */
  simOnly: boolean;
}

/** Quais tarefas rodar. `--only` escolhe pelo id, mas não passa por cima de `demoLogin` nem do modo sim. Pura. */
export function select(tasks: BenchTask[], sel: Selection): { run: BenchTask[]; unknown: string[]; skipped: { id: string; why: string }[] } {
  const ids = new Set(tasks.map((t) => t.id));
  const unknown = (sel.only ?? []).filter((id) => !ids.has(id));
  const skipped: { id: string; why: string }[] = [];
  const run = tasks.filter((task) => {
    if (sel.only && !sel.only.includes(task.id)) return false;
    if (sel.kind && task.kind !== sel.kind) return false;
    if (sel.simOnly && !task.sim) { skipped.push({ id: task.id, why: "sem página simulada" }); return false; }
    if (task.demoLogin && !sel.includeDemoLogin) { skipped.push({ id: task.id, why: "pede o login de demonstração: use --demo-login" }); return false; }
    if (!sel.only && task.kind === "public" && !sel.includePublic && !task.demoLogin) { skipped.push({ id: task.id, why: "tarefa pública: use --public" }); return false; }
    return true;
  });
  return { run, unknown, skipped };
}

/** O teto de gasto do modo real: quantas tarefas e quantas consultas ao Jev (sondas). */
export interface RealBudget {
  maxTasks: number;
  maxProbes: number;
}

/** Pode começar mais uma tarefa? Cada tarefa pode gastar até `maxSteps` consultas, então a conta é pelo pior caso. Pura. */
export function canStart(budget: RealBudget, startedTasks: number, usedProbes: number, next: Pick<BenchTask, "maxSteps">): { ok: boolean; why?: string } {
  if (startedTasks >= budget.maxTasks) return { ok: false, why: `limite de ${budget.maxTasks} tarefas reais (--max-real)` };
  if (usedProbes + next.maxSteps > budget.maxProbes) return { ok: false, why: `o pior caso passaria de ${budget.maxProbes} sondas (--max-probes; gastas ${usedProbes})` };
  return { ok: true };
}
