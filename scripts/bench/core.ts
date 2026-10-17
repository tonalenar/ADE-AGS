/**
 * Lógica PURA do benchmark do piloto do Jev (`scripts/jev-bench.ts`): critérios de sucesso verificáveis pela página,
 * classificação de cada rodada, relógio e fases de tempo, agregação de métricas, leitura do relatório do
 * `ags portal act` e as tabelas em Markdown. Nada aqui toca rede, disco ou navegador: é o que o vitest cobre.
 */
import { parseSnapshot, type ParsedPage, type PilotDeps, type PilotResult } from "../../src/features/browser/jevPilot";

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

/**
 * Os `--expect` equivalentes a um critério de sucesso (plano v2, Fase 5): `--with-expect` passa ao `act` o que a PÁGINA tem de
 * mostrar, para medir o falso «feito» COM a conferência por código. `any` e `not` de outra coisa que texto não viram `--expect`.
 */
export function expectsFor(criterion: Criterion): string[] {
  switch (criterion.kind) {
    case "text": return [`text:${criterion.value}`];
    case "urlIncludes": return [`url:${criterion.value}`];
    case "regex": return [`text:/${criterion.pattern}/`];
    case "all": return criterion.of.flatMap(expectsFor);
    case "not": return criterion.of.kind === "text" ? [`absent:${criterion.of.value}`] : [];
    case "any": return [];
  }
}

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
  /**
   * SONDA: site público instável (Amazon/WAF, A/B) — aparece no relatório numa seção à parte e fica FORA dos portões
   * (taxa de sucesso, falso «feito»…), conforme o plano v2 (riscos: «Amazon/WAF muda sem aviso»).
   */
  probe?: boolean;
  /**
   * Quantos `act` seguidos com o MESMO objetivo (padrão 1). Com 2, a tarefa reproduz o agente que repete o `act` (rodada 5
   * do plano: o histórico zerava e o item entrava duas vezes): o critério é contado depois do último.
   */
  acts?: number;
  /**
   * Página com XHR que pode terminar DEPOIS de o `act` devolver: no real, o critério é conferido no snapshot logo após o
   * `act` E de novo depois de tantos ms (tem de valer nos dois). O sim usa o fim do XHR simulado.
   */
  settleMs?: number;
  /** De qual leva é (`v1` = as 23 originais; `v2` = as 10 novas do plano v2). */
  set?: "v1" | "v2" | "teste";
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
    // Os `--expect` conferidos durante o act (J3/J5): uma leitura de página, contada como snapshot.
    ...(deps.expectsMet ? { expectsMet: (seen?: ParsedPage) => timed("snapshotMs", () => deps.expectsMet!(seen)) } : {}),
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
  /** A conferência por código do `act` (Fase 5): FEITO (verificado), FEITO (não verificado) ou NÃO CONFERE. Ausente num relatório antigo. */
  verdict?: "verified" | "unverified" | "mismatch";
  /** Consultas ao Jev (operação+elemento) e fotos que a rodada gastou: a cota. */
  probes?: number;
  /** A causa da falha, classificada à mão a partir do relatório do act (`--causes`). */
  cause?: string;
  /** O relatório do `act` como veio (só no real, cortado): serve para classificar a causa de uma falha. */
  report?: string;
  /** Qual repetição (0, 1, …) com `--repeat`, e a posição da tarefa na ordem embaralhada daquela repetição. */
  rep?: number;
  order?: number;
  /** Quantos `act` a tarefa gastou e quanto durou cada um (ms). */
  acts?: number;
  actMs?: number[];
  /** As consultas de texto ao Jev: tamanho e latência de cada uma, e os tokens (estimados por bytes/4 quando o relatório não traz). */
  queries?: QueryStats;
  /** O batimento da janela que o relatório do act traz (`window: {…}`, Fase 0.1). Ausente num relatório que não tem. */
  window?: WindowStats;
  /** A janela/ponte não respondeu (timeout do `ask_frontend`, «a janela não respondeu a tempo»): é travamento, não falha do piloto. */
  windowHang?: boolean;
}

export interface QueryStats {
  count: number;
  /** Bytes de cada consulta (UTF-8 do estado + opções + alvos). Vazio quando o relatório não traz. */
  bytes: number[];
  /** Latência de cada consulta, ms. */
  latencyMs: number[];
  /** Tokens da tarefa; `null` = sem dado nenhum (nem tokens, nem bytes). */
  tokens: number | null;
  /** `true` = tokens estimados por bytes/4 (o relatório não trouxe a contagem do provedor). */
  tokensEstimated: boolean;
}

/** O batimento do renderizador (Fase 0.1): todos opcionais — o bench é tolerante a quem ainda não tem. */
export interface WindowStats {
  lagMaxMs?: number;
  lagP95Ms?: number;
  samples?: number;
  hiddenMs?: number;
  timeouts?: number;
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
  /** A latência de cada consulta ao Jev (os «NNN ms» dos passos), na ordem. */
  jevLatencies: number[];
  /** O batimento da janela, se o relatório trouxer (`window: {…}`, `JANELA: {…}`, `TEMPOS.window` ou «janela: lag máx N ms»). */
  window: WindowStats | null;
  /** Bytes por consulta e tokens, se a linha TEMPOS trouxer (`bytes`: número ou lista; `tokens`: número). */
  queryBytes: number[];
  tokens: number | null;
  /** O veredito da conferência (`FEITO (verificado)`, `FEITO (não verificado)`, `NÃO CONFERE`); `null` sem ele. */
  verdict: "verified" | "unverified" | "mismatch" | null;
}

const WINDOW_KEYS: (keyof WindowStats)[] = ["lagMaxMs", "lagP95Ms", "samples", "hiddenMs", "timeouts"];

/** Só os números conhecidos de um objeto `window`; `null` se não sobrar nenhum. Pura. */
export function windowOf(raw: unknown): WindowStats | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const out: WindowStats = {};
  for (const key of WINDOW_KEYS) if (typeof record[key] === "number" && Number.isFinite(record[key])) out[key] = record[key] as number;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * O batimento da janela numa linha do relatório, em qualquer das formas que o contrato da Fase 0.1 pode tomar: a linha
 * `TEMPOS: {…, "window": {…}}`, uma linha `window: {…}` / `JANELA: {…}`, ou o texto «janela: lag máx 1234 ms». Pura.
 */
export function parseWindowLine(line: string): WindowStats | null {
  const json = /^(?:TEMPOS|JANELA|janela|window|WINDOW):\s*(\{.*\})\s*$/.exec(line.trim());
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json[1]);
      const nested = windowOf((parsed as { window?: unknown }).window);
      return nested ?? (/^TEMPOS/.test(line.trim()) ? null : windowOf(parsed));
    } catch { return null; }
  }
  const text = /janela:?\s*lag m[áa]x(?:imo)?\.?\s*(\d+)\s*ms/i.exec(line);
  return text ? { lagMaxMs: Number(text[1]) } : null;
}

/** `bytes` e `tokens` da linha TEMPOS, quando o piloto passar a trazê-los (Fase 4.2). Pura. */
export function parseQueryExtras(line: string): { bytes: number[]; tokens: number | null } | null {
  if (!line.startsWith("TEMPOS: ")) return null;
  try {
    const raw = JSON.parse(line.slice("TEMPOS: ".length)) as Record<string, unknown>;
    const b = raw.bytes;
    const bytes = Array.isArray(b) ? b.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : typeof b === "number" && Number.isFinite(b) ? [b] : [];
    const tokens = typeof raw.tokens === "number" && Number.isFinite(raw.tokens) ? raw.tokens : null;
    return { bytes, tokens };
  } catch { return null; }
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
  ["PAROU (Jev sem certeza)", "unsure"], ["PAROU", "stuck"], ["FEITO (verificado)", "done"], ["FEITO (não verificado)", "done"], ["FEITO", "done"], ["NÃO CONFERE", "unsure"], ["NÃO RODOU", "off"], ["LIMITE DE PASSOS", "limit"], ["ERRO", "error"],
];
const FINAL_MARK = "A página agora (o Jev só escolhe onde tocar: confira o resultado):";

/** Lê o texto que o `act` devolve (ver `formatResult` em `jevPilot.ts`). Pura. */
export function parseActReport(report: string): ActReport {
  const lines = report.split("\n");
  const head = lines[0] ?? "";
  const outcome = HEADS.find(([label]) => head.endsWith(`: ${label}`))?.[1] ?? null;
  const verdict = head.endsWith(": FEITO (verificado)") ? "verified" : head.endsWith(": FEITO (não verificado)") ? "unverified" : head.endsWith(": NÃO CONFERE") ? "mismatch" : null;
  const at = lines.indexOf(FINAL_MARK);
  const stepLines = lines.slice(0, at === -1 ? lines.length : at);
  let steps = 0;
  let autoFills = 0;
  let photos = 0;
  let jevMs = 0;
  const stepMs: number[] = [];
  const jevLatencies: number[] = [];
  let blocked = false;
  let timings: ReportTimings | null = null;
  let window: WindowStats | null = null;
  let extras: { bytes: number[]; tokens: number | null } | null = null;
  for (const line of stepLines) {
    timings ??= parseTimings(line);
    window ??= parseWindowLine(line);
    extras ??= parseQueryExtras(line);
    // `recusou …` (clique) ou `… compra ou pagamento … não toquei/não cliquei` (foto, nota): a trava `blockedPurchase`.
    if (/recusou |compra ou (um )?pagamento/.test(line)) blocked = true;
    if (/^\d+\. /.test(line)) steps += 1;
    if (line.includes("sem o Jev)")) autoFills += 1;
    if (line.includes("tocou pela foto")) photos += 1;
    // `(p=0.95, fim p=0.10, 450 ms, passo 900 ms)`: o 1.º «ms» é a consulta ao Jev; o «passo» é o passo inteiro.
    const ms = /, (\d+) ms(?:,|\))/.exec(line);
    if (ms && /^\d+\. /.test(line) && !line.includes("tocou pela foto")) jevLatencies.push(Number(ms[1]));
    if (ms) jevMs += Number(ms[1]);
    const whole = /passo (\d+) ms\)/.exec(line);
    if (whole) stepMs.push(Number(whole[1]));
  }
  return {
    outcome, steps, autoFills, photos, jevMs, stepMs, timings, blocked, finalSnapshot: at === -1 ? "" : lines.slice(at + 1).join("\n"),
    jevLatencies, window, queryBytes: extras?.bytes ?? [], tokens: extras?.tokens ?? null, verdict,
  };
}

/**
 * As consultas de uma rodada REAL a partir do relatório: quantas (TEMPOS.consultas, ou as latências lidas), a latência de
 * cada uma, os bytes e os tokens. Sem tokens no relatório, estima por bytes/4 e marca como estimativa; sem bytes, `null`. Pura.
 */
export function queriesFromReport(report: Pick<ActReport, "jevLatencies" | "timings" | "queryBytes" | "tokens">): QueryStats {
  const count = report.timings?.consultas ?? report.jevLatencies.length;
  if (report.tokens !== null) return { count, bytes: report.queryBytes, latencyMs: report.jevLatencies, tokens: report.tokens, tokensEstimated: false };
  const total = report.queryBytes.reduce((a, b) => a + b, 0);
  return { count, bytes: report.queryBytes, latencyMs: report.jevLatencies, tokens: report.queryBytes.length > 0 ? Math.round(total / 4) : null, tokensEstimated: true };
}

/** Soma as consultas de vários `act` da mesma tarefa. Pura. */
export function mergeQueries(parts: QueryStats[]): QueryStats {
  const tokens = parts.some((p) => p.tokens !== null) ? parts.reduce((a, p) => a + (p.tokens ?? 0), 0) : null;
  return {
    count: parts.reduce((a, p) => a + p.count, 0),
    bytes: parts.flatMap((p) => p.bytes),
    latencyMs: parts.flatMap((p) => p.latencyMs),
    tokens,
    tokensEstimated: parts.some((p) => p.tokensEstimated),
  };
}

/** A janela não respondeu: timeout da ponte (`ask_frontend`), «a janela não respondeu a tempo», ou timeouts no batimento. Pura. */
export function isWindowHang(run: Pick<TaskRun, "outcome" | "note" | "report" | "window">): boolean {
  if ((run.window?.timeouts ?? 0) > 0) return true;
  if (run.outcome !== "crash" && run.outcome !== "error") return false;
  return /janela n[ãa]o respondeu|n[ãa]o respondeu a tempo|window (did not|didn't) respond|frontend (did not|didn't) respond|recv_timeout|ask_frontend/i.test(`${run.note ?? ""}\n${run.report ?? ""}`);
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

/**
 * Percentil `p` (0–100) por interpolação linear entre os vizinhos (o «tipo 7» das planilhas): p50 é a mediana, p95 de
 * [1..20] é 19,05. Vazio → 0. Pura.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

// ── Semente, ordem e repetição ──────────────────────────────────────

/** Um número de 32 bits a partir de partes (FNV-1a): a mesma semente + tarefa + repetição dá sempre o mesmo. Pura. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Gerador pseudoaleatório pequeno e repetível (mulberry32), em [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates com o gerador dado; não muda a lista de entrada. */
export function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A ordem de cada repetição: embaralhada com a semente (uma por repetição), e a repetição seguinte na ordem INVERSA da
 * anterior quando `alternate` — a tarefa que veio por último numa vem cedo na outra, e um efeito de ordem (cache aquecido,
 * janela cansada) não vicia uma tarefa só. Pura.
 */
export function repetitionPlan<T>(items: T[], repeat: number, seed: number, alternate = true): { rep: number; items: T[] }[] {
  const plan: { rep: number; items: T[] }[] = [];
  for (let rep = 0; rep < repeat; rep++) {
    const order = alternate && rep % 2 === 1 ? [...plan[rep - 1].items].reverse() : shuffled(items, rng(hashSeed(seed, "ordem", rep)));
    plan.push({ rep, items: order });
  }
  return plan;
}

// ── Métricas v2 (Fase 0.3) ─────────────────────────────────────────

/** As métricas de um grupo de rodadas (portão, locais, públicas, sondas). */
export interface GroupMetrics {
  runs: number;
  tasks: number;
  successes: number;
  successRate: number;
  falseDone: number;
  /** Falso «parou»: o critério valia e o piloto parou (`unsure`/`stuck`). */
  falseStop: number;
  /** NÃO CONFERE que pegou um falso «feito» (a página realmente não cumpria o critério). */
  caught: number;
  /** FEITO (verificado) e o critério falha: a conferência deixou passar. A meta é 0. */
  verifiedWrong: number;
  violations: number;
  stepP50: number;
  stepP95: number;
  /** Duração de cada `act` (ms). */
  actP50: number;
  actP95: number;
  actsPerTask: number;
  /** Rodadas em que a janela/ponte não respondeu. */
  windowHangs: number;
  /** O maior `window.lagMaxMs` visto; `null` = nenhum relatório trouxe o batimento. */
  lagMaxMs: number | null;
  queriesPerTask: number;
  /** Média de tokens por tarefa; `null` = sem dado. */
  tokensPerTask: number | null;
  tokensEstimated: boolean;
  bytesPerQueryP50: number | null;
  bytesPerQueryP95: number | null;
  queryLatencyP50: number | null;
  queryLatencyP95: number | null;
}

export interface TaskMetrics {
  id: string;
  kind: "local" | "public";
  probe: boolean;
  runs: number;
  successes: number;
  falseDone: number;
  falseStop: number;
  violations: number;
  stepP50: number;
  stepP95: number;
  actsPerTask: number;
  queriesPerTask: number;
  tokensPerTask: number | null;
}

export interface MetricsV2 {
  /** O que conta para os portões: locais + públicas, SEM as sondas. */
  gate: GroupMetrics;
  local: GroupMetrics;
  /** Públicas fora as sondas. */
  public: GroupMetrics;
  /** Sondas (Amazon…): só informativo, fora dos portões. */
  probe: GroupMetrics;
  tasks: TaskMetrics[];
}

const actsOf = (r: TaskRun) => r.acts ?? 1;
const actDurations = (r: TaskRun) => (r.actMs && r.actMs.length > 0 ? r.actMs : [r.totalMs]);

/** Agrega um grupo de rodadas. Pura. */
export function groupMetrics(runs: TaskRun[]): GroupMetrics {
  const verdicts = runs.map(judge);
  const successes = verdicts.filter((v) => v.completed).length;
  const lags = runs.map((r) => r.window?.lagMaxMs).filter((x): x is number => typeof x === "number");
  const withQueries = runs.filter((r) => r.queries);
  const bytes = withQueries.flatMap((r) => r.queries!.bytes);
  const latency = withQueries.flatMap((r) => r.queries!.latencyMs);
  const tokenRuns = withQueries.filter((r) => r.queries!.tokens !== null);
  return {
    runs: runs.length,
    tasks: new Set(runs.map((r) => r.id)).size,
    successes,
    successRate: runs.length > 0 ? successes / runs.length : 0,
    falseDone: verdicts.filter((v) => v.falseDone).length,
    falseStop: verdicts.filter((v) => v.falseUnsure).length,
    caught: runs.filter((r, i) => r.verdict === "mismatch" && !verdicts[i].completed).length,
    verifiedWrong: runs.filter((r, i) => r.verdict === "verified" && !verdicts[i].completed).length,
    violations: verdicts.filter((v) => v.violation).length,
    stepP50: percentile(runs.flatMap((r) => r.stepMs), 50),
    stepP95: percentile(runs.flatMap((r) => r.stepMs), 95),
    actP50: percentile(runs.flatMap(actDurations), 50),
    actP95: percentile(runs.flatMap(actDurations), 95),
    actsPerTask: mean(runs.map(actsOf)),
    windowHangs: runs.filter((r) => r.windowHang || isWindowHang(r)).length,
    lagMaxMs: lags.length > 0 ? Math.max(...lags) : null,
    queriesPerTask: mean(runs.map((r) => r.queries?.count ?? r.probes ?? 0)),
    tokensPerTask: tokenRuns.length > 0 ? mean(tokenRuns.map((r) => r.queries!.tokens!)) : null,
    tokensEstimated: tokenRuns.some((r) => r.queries!.tokensEstimated),
    bytesPerQueryP50: bytes.length > 0 ? percentile(bytes, 50) : null,
    bytesPerQueryP95: bytes.length > 0 ? percentile(bytes, 95) : null,
    queryLatencyP50: latency.length > 0 ? percentile(latency, 50) : null,
    queryLatencyP95: latency.length > 0 ? percentile(latency, 95) : null,
  };
}

/**
 * O PORTÃO de liberação (plano v2, Fase 7): o que uma rodada do portão (locais + públicas, SEM sondas) precisa cumprir antes de
 * um instalador. Sucesso ≥ 90%, falso «feito» ≤ 2%, mediana por passo ≤ 700 ms, 0 travamentos da janela, 0 «verificado» errado.
 */
export interface ReleaseLimits {
  minSuccessRate: number;
  maxFalseDoneRate: number;
  maxStepP50Ms: number;
  maxWindowHangs: number;
  maxVerifiedWrong: number;
}

export const RELEASE_LIMITS: ReleaseLimits = { minSuccessRate: 0.9, maxFalseDoneRate: 0.02, maxStepP50Ms: 700, maxWindowHangs: 0, maxVerifiedWrong: 0 };

/** Confere um grupo contra os limites. Sem rodadas, não passa (nada foi medido). Pura. */
export function gateCheck(g: GroupMetrics, limits: ReleaseLimits = RELEASE_LIMITS): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (g.runs === 0) return { ok: false, failures: ["nenhuma rodada no portão"] };
  if (g.successRate < limits.minSuccessRate) failures.push(`sucesso ${pct(g.successRate)} < ${pct(limits.minSuccessRate)}`);
  const falseRate = g.falseDone / g.runs;
  if (falseRate > limits.maxFalseDoneRate) failures.push(`falso «feito» ${pct(falseRate)} > ${pct(limits.maxFalseDoneRate)}`);
  // Sem tempo de passo medido (relatório antigo) o percentil é 0: não reprova por falta de dado.
  if (g.stepP50 > limits.maxStepP50Ms) failures.push(`mediana por passo ${Math.round(g.stepP50)} ms > ${limits.maxStepP50Ms} ms`);
  if (g.windowHangs > limits.maxWindowHangs) failures.push(`${g.windowHangs} travamento(s) da janela > ${limits.maxWindowHangs}`);
  if (g.verifiedWrong > limits.maxVerifiedWrong) failures.push(`${g.verifiedWrong} «verificado» errado > ${limits.maxVerifiedWrong}`);
  return { ok: failures.length === 0, failures };
}

/** As métricas v2: portão (sem sondas), locais × públicas, sondas à parte e uma linha por tarefa. Pura. */
export function summarizeV2(tasks: Pick<BenchTask, "id" | "kind" | "probe">[], runs: TaskRun[]): MetricsV2 {
  const meta = new Map(tasks.map((t) => [t.id, t]));
  const isProbe = (r: TaskRun) => meta.get(r.id)?.probe === true;
  const kindOf = (r: TaskRun) => meta.get(r.id)?.kind ?? "local";
  const ids = [...new Set(runs.map((r) => r.id))];
  return {
    gate: groupMetrics(runs.filter((r) => !isProbe(r))),
    local: groupMetrics(runs.filter((r) => !isProbe(r) && kindOf(r) === "local")),
    public: groupMetrics(runs.filter((r) => !isProbe(r) && kindOf(r) === "public")),
    probe: groupMetrics(runs.filter(isProbe)),
    tasks: ids.map((id) => {
      const mine = runs.filter((r) => r.id === id);
      const g = groupMetrics(mine);
      return {
        id, kind: meta.get(id)?.kind ?? "local", probe: meta.get(id)?.probe === true, runs: g.runs, successes: g.successes,
        falseDone: g.falseDone, falseStop: g.falseStop, violations: g.violations, stepP50: g.stepP50, stepP95: g.stepP95,
        actsPerTask: g.actsPerTask, queriesPerTask: g.queriesPerTask, tokensPerTask: g.tokensPerTask,
      };
    }),
  };
}

/**
 * Uma impressão dos NÚMEROS da rodada (métricas e rodadas, sem data nem commit): duas rodadas com a mesma semente no
 * simulador têm de dar a mesma. É o que prova que o método é reproduzível. Pura.
 */
export function digestOf(report: Pick<BenchReport, "runs" | "v2" | "seed" | "repeat">): string {
  const body = JSON.stringify({ seed: report.seed, repeat: report.repeat, v2: report.v2, runs: report.runs.map(({ report: _r, ...rest }) => rest) });
  return hashSeed(body).toString(16).padStart(8, "0");
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

/**
 * O JSON de uma rodada. `schema: 1` (as rodadas antigas) só tem `summary`; `schema: 2` acrescenta semente, repetição,
 * ordem e as métricas v2 (`v2`) — `summary` continua lá, sobre TODAS as rodadas, para o `--compare` com um JSON antigo.
 */
export interface BenchReport {
  schema: 1 | 2;
  label: string;
  mode: "sim" | "real";
  startedAt: string;
  commit?: string;
  /** Semente da ordem (e da latência simulada) e quantas repetições por tarefa (v2). */
  seed?: number;
  repeat?: number;
  /** `embaralhada+alternada` (v2). */
  order?: string;
  runs: TaskRun[];
  summary: Summary;
  v2?: MetricsV2;
  /** Impressão dos números (`digestOf`): mesma semente no sim ⇒ mesma impressão. */
  digest?: string;
}

export function buildReport(
  meta: Pick<BenchReport, "label" | "mode" | "startedAt" | "commit"> & Partial<Pick<BenchReport, "seed" | "repeat" | "order">>,
  runs: TaskRun[],
  tasks?: Pick<BenchTask, "id" | "kind" | "probe">[],
): BenchReport {
  if (!tasks) return { schema: 1, ...meta, runs, summary: summarize(runs) };
  const report: BenchReport = { schema: 2, ...meta, runs, summary: summarize(runs), v2: summarizeV2(tasks, runs) };
  return { ...report, digest: digestOf(report) };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const pct1 = (value: number) => `${(value * 100).toFixed(1)}%`;
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

/**
 * Várias rodadas lado a lado (ANTES → DEPOIS → DEPOIS 2…): o resumo e uma coluna de resultado por rodada, com os passos e
 * o tempo da tarefa. A tarefa que uma rodada não mediu aparece como «—». Pura.
 */
export function renderTrend(tasks: BenchTask[], rounds: { name: string; report: BenchReport }[]): string {
  const head = (first: string) => `| ${first} | ${rounds.map((r) => r.name).join(" | ")} |\n|---|${rounds.map(() => "---").join("|")}|`;
  const rows: [string, (s: Summary) => string][] = [
    ["tarefas medidas", (s) => String(s.tasks)],
    ["concluídas sem ajuda à mão (critério vale)", (s) => `${s.completed}/${s.tasks} (${pct(s.completedRate)})`],
    ["… e o piloto confirmou (done)", (s) => (s.confirmed === undefined ? "—" : `${s.confirmed}/${s.tasks} (${pct(s.confirmed / Math.max(1, s.tasks))})`)],
    ["falso «concluído»", (s) => String(s.falseDone)],
    ["falso «sem certeza»", (s) => String(s.falseUnsure)],
    ["violações", (s) => String(s.violations)],
    ["tempo por tarefa (mediana)", (s) => secs(s.medianTotalMs)],
    ["tempo por passo (mediana)", (s) => ms0(s.medianStepMs)],
    ["fase: consulta ao Jev (+foto)", (s) => pct(s.share.jevMs)],
    ["fase: snapshot", (s) => pct(s.share.snapshotMs)],
    ["fase: ação", (s) => pct(s.share.actionMs)],
    ["fase: espera", (s) => pct(s.share.waitMs)],
    ["fase: outros/não medido", (s) => pct(s.share.otherMs)],
  ];
  const summary = [head("métrica"), ...rows.map(([label, f]) => `| ${label} | ${rounds.map((r) => f(r.report.summary)).join(" | ")} |`)].join("\n");
  const byRound = rounds.map((r) => new Map(r.report.runs.map((run) => [run.id, run])));
  const lines = tasks.filter((t) => byRound.some((m) => m.has(t.id))).map((t) => {
    const cells = byRound.map((m) => {
      const run = m.get(t.id);
      return run ? `${mark(run)} · ${run.steps}p · ${secs(run.totalMs)}` : "—";
    });
    return `| ${t.id} | ${cells.join(" | ")} |`;
  });
  return [summary, "", head("tarefa (resultado · passos · tempo)"), ...lines].join("\n");
}

const opt = (value: number | null, f: (x: number) => string) => (value === null ? "—" : f(value));

/**
 * Intervalo de confiança de Wilson (95% por padrão) para `k` acertos em `n` rodadas. Com amostra pequena o «100%» do bench
 * é enganoso: 54/54 dá [93%, 100%] e, contando que as repetições são quase a mesma rodada (~27 efetivas), [87%, 100%].
 * É esse limite inferior que diz o quanto se pode prometer. Pura.
 */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** A meta do protocolo J2 (ver `docs/ade-ags/bench/PROTOCOLO_J2.md`): H1 «acerta ≥ 98%» contra H0 «acerta ≤ 95%». */
export const SPRT_GOOD = 0.98;
export const SPRT_BAD = 0.95;

/**
 * Teste sequencial de Wald (SPRT): com `k` acertos em `n` rodadas, já dá para dizer que o piloto atinge a meta (`p ≥ good`),
 * que não atinge (`p ≤ bad`), ou é preciso rodar mais. Para cedo quando o resultado é claro, sem fixar o N antes. Pura.
 */
export function sprt(k: number, n: number, good = SPRT_GOOD, bad = SPRT_BAD, alpha = 0.05, beta = 0.05): "atinge" | "não atinge" | "rodar mais" {
  const failures = n - k;
  const llr = k * Math.log(good / bad) + failures * Math.log((1 - good) / (1 - bad));
  if (llr >= Math.log((1 - beta) / alpha)) return "atinge";
  if (llr <= Math.log(beta / (1 - alpha))) return "não atinge";
  return "rodar mais";
}

/** A tabela de grupos v2: portão × locais × públicas × sondas (fora). Pura. */
export function renderGroups(v2: MetricsV2): string {
  const cols = [v2.gate, v2.local, v2.public, v2.probe];
  const rows: [string, (g: GroupMetrics) => string][] = [
    ["rodadas (tarefas)", (g) => `${g.runs} (${g.tasks})`],
    ["sucesso (critério vale, nada proibido)", (g) => (g.runs === 0 ? "—" : `${g.successes}/${g.runs} (${pct(g.successRate)})`)],
    ["sucesso IC 95% (Wilson)", (g) => (g.runs === 0 ? "—" : (({ low, high }) => `${pct1(low)} – ${pct1(high)}`)(wilson(g.successes, g.runs)))],
    ["SPRT: meta ≥ 98% (contra ≤ 95%)", (g) => (g.runs === 0 ? "—" : sprt(g.successes, g.runs))],
    ["erro silencioso (falso «feito» + violações), teto IC 95%", (g) => (g.runs === 0 ? "—" : `${g.falseDone + g.violations}/${g.runs} · até ${pct1(wilson(g.falseDone + g.violations, g.runs).high)}`)],
    ["falso «feito»", (g) => String(g.falseDone)],
    ["falso «parou»", (g) => String(g.falseStop)],
    ["NÃO CONFERE (pegou falso «feito»)", (g) => String(g.caught)],
    ["«verificado» errado (meta 0)", (g) => String(g.verifiedWrong)],
    ["violações", (g) => String(g.violations)],
    ["tempo por passo p50 · p95", (g) => `${ms0(g.stepP50)} · ${ms0(g.stepP95)}`],
    ["tempo por `act` p50 · p95", (g) => `${ms0(g.actP50)} · ${ms0(g.actP95)}`],
    ["`act` por tarefa (média)", (g) => g.actsPerTask.toFixed(2)],
    ["travamentos da janela", (g) => String(g.windowHangs)],
    ["lag máx. da janela", (g) => opt(g.lagMaxMs, ms0)],
    ["consultas ao Jev por tarefa (média)", (g) => g.queriesPerTask.toFixed(1)],
    ["tokens por tarefa (média)", (g) => opt(g.tokensPerTask, (x) => `${Math.round(x)}${g.tokensEstimated ? " (est. bytes/4)" : ""}`)],
    ["bytes por consulta p50 · p95", (g) => (g.bytesPerQueryP50 === null ? "—" : `${Math.round(g.bytesPerQueryP50)} · ${Math.round(g.bytesPerQueryP95 ?? 0)}`)],
    ["latência por consulta p50 · p95", (g) => (g.queryLatencyP50 === null ? "—" : `${ms0(g.queryLatencyP50)} · ${ms0(g.queryLatencyP95 ?? 0)}`)],
  ];
  return [
    "| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |",
    "|---|---|---|---|---|",
    ...rows.map(([label, f]) => `| ${label} | ${cols.map(f).join(" | ")} |`),
  ].join("\n");
}

/** Uma linha por tarefa: k/N, falsos, tempos p50/p95, `act`, consultas e tokens. Pura. */
export function renderTaskMetrics(tasks: BenchTask[], v2: MetricsV2): string {
  const byId = new Map(v2.tasks.map((t) => [t.id, t]));
  const rows = tasks.filter((t) => byId.has(t.id)).map((task) => {
    const m = byId.get(task.id)!;
    const flag = m.probe ? "sonda" : task.kind;
    return `| ${task.id} | ${flag} | ${m.successes}/${m.runs} | ${m.falseDone} | ${m.falseStop} | ${ms0(m.stepP50)} · ${ms0(m.stepP95)} | ${m.actsPerTask.toFixed(1)} | ${m.queriesPerTask.toFixed(1)} | ${opt(m.tokensPerTask, (x) => String(Math.round(x)))} |`;
  });
  return ["| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

/** As falhas agrupadas por tarefa (quantas das N e o desfecho mais comum). Pura. */
export function renderFailuresV2(tasks: BenchTask[], report: BenchReport): string {
  const lines = tasks.flatMap((task) => {
    const mine = report.runs.filter((r) => r.id === task.id);
    const bad = mine.filter((r) => !judge(r).completed || judge(r).falseUnsure);
    if (bad.length === 0) return [];
    const kinds = new Map<string, number>();
    for (const r of bad) {
      const v = judge(r);
      const k = v.violation ? "violação" : v.falseDone ? "falso «feito»" : v.falseUnsure ? "falso «parou»" : r.windowHang ? "travamento da janela" : `parou: ${r.outcome}`;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const what = [...kinds].map(([k, n]) => `${k} ×${n}`).join(", ");
    const note = bad.find((r) => r.note)?.note;
    return [`- **${task.id}**${task.probe ? " (sonda)" : ""} — ${bad.length}/${mine.length}: ${what}${task.note ? `. ${task.note}` : ""}${note ? ` [${note.slice(0, 160)}]` : ""}`];
  });
  return lines.length > 0 ? lines.join("\n") : "Nenhuma.";
}

export function renderMarkdown(tasks: BenchTask[], report: BenchReport, baseline?: BenchReport): string {
  if (report.v2) {
    return [
      `### ${report.label} — modo ${report.mode}${report.commit ? ` · ${report.commit}` : ""} · ${report.startedAt}`,
      "",
      `Semente ${report.seed ?? "—"} · ${report.repeat ?? 1} repetição(ões) por tarefa · ordem ${report.order ?? "fixa"} · impressão dos números \`${report.digest ?? "—"}\``,
      "",
      renderGroups(report.v2),
      "",
      "Por tarefa (sondas fora dos portões):",
      "",
      renderTaskMetrics(tasks, report.v2),
      "",
      "Falhas:",
      renderFailuresV2(tasks, report),
      ...(baseline ? ["", `Comparação com «${baseline.label}» (${baseline.mode}${baseline.commit ? ` · ${baseline.commit}` : ""}; métricas antigas, todas as rodadas):`, "", renderSummary(report, baseline)] : []),
    ].join("\n");
  }
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

// ── Servidor das fixtures: atraso e API (Fase 0.4) ──────────────────

/** Teto do atraso pedido por `?delay=` (ms): nada de pedido pendurado para sempre. */
export const MAX_DELAY_MS = 30_000;

/** `?delay=8000` → 8000 (limitado a `MAX_DELAY_MS`); ausente/ inválido → 0. Pura. */
export function parseDelay(search: string): number {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("delay");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_DELAY_MS, Math.floor(n)) : 0;
}

const PRODUCTS = ["Caneca Azul", "Caneca de Vidro", "Caneca Esmaltada", "Garrafa Térmica"];
const CITIES = ["São Paulo - SP", "São Pedro - SP", "São Paulo de Olivença - AM", "Santos - SP", "Salvador - BA"];
const SUGGESTIONS = ["fone bluetooth", "fone com fio", "fone gamer", "fonte de alimentação"];

/**
 * As respostas JSON que as fixtures pedem por XHR/fetch (`/api/busca`, `/api/filtro`, `/api/sugestoes`). Dados fictícios.
 * `null` = rota desconhecida (404). O atraso é aplicado por quem serve (`?delay=` vale para HTML e para a API). Pura.
 */
export function fixtureApi(path: string, search: string): { status: number; body: unknown } | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const term = fold(q.get("q") ?? "");
  switch (path) {
    case "/api/busca":
      return { status: 200, body: { q: q.get("q") ?? "", results: term ? PRODUCTS.filter((p) => fold(p).includes(term.split(" ")[0])) : [] } };
    case "/api/filtro":
      return { status: 200, body: q.get("frete") === "1" ? { total: 3, label: "Mostrando 3 produtos com frete grátis" } : { total: 12, label: "Mostrando 12 produtos" } };
    case "/api/sugestoes": {
      const list = q.get("tipo") === "cidade" ? CITIES : SUGGESTIONS;
      return { status: 200, body: { q: q.get("q") ?? "", options: term ? list.filter((c) => fold(c).startsWith(term)) : [] } };
    }
    case "/api/carrinho":
      return { status: 200, body: { ok: true, quantidade: Number(q.get("quantidade") ?? "1") || 1 } };
    default:
      return null;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * `/s?k=caneca`: uma página de resultados renderizada no servidor (como a busca da Amazon), com o formulário de busca que
 * volta para `/s`. Com `&delay=8000` o servidor a entrega 8 s depois: a navegação lenta que o piloto lia cedo demais. Pura.
 */
export function fixtureSearchPage(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const k = params.get("k") ?? "";
  const product = params.get("p");
  if (product) return `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(product)} — ShopMart</title><link rel="stylesheet" href="/common.css"></head>\n<body><h1>Produto: ${escapeHtml(product)}</h1><p>R$ 29,90</p></body></html>\n`;
  const results = (fixtureApi("/api/busca", `q=${encodeURIComponent(k)}`)?.body as { results: string[] }).results;
  const delay = parseDelay(search);
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>ShopMart — busca</title><link rel="stylesheet" href="/common.css"></head>
<body><h1>ShopMart</h1>
<form action="/s" method="get"><input type="search" name="k" aria-label="Buscar produtos" value="${escapeHtml(k)}">${delay > 0 ? `<input type="hidden" name="delay" value="${delay}">` : ""}<button type="submit">Buscar</button></form>
${k ? `<h2>Resultados para: ${escapeHtml(k)}</h2><ul>${results.map((r) => `<li><a href="/s?p=${encodeURIComponent(r)}">${escapeHtml(r)}</a></li>`).join("")}</ul>` : ""}
</body></html>
`;
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
