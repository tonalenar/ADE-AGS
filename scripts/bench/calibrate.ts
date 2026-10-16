/**
 * Calibração dos limites do piloto (plano v2, 4.5, achado D3): `MIN_PROBABILITY`, `MIN_GOAL_DONE`, `MIN_FOUND` (e a
 * confiança da caixa). Lógica PURA — o `scripts/jev-calibrate.ts` lê os arquivos; aqui só se conta.
 *
 * Duas fontes, que respondem coisas diferentes:
 *  - os relatórios do benchmark REAL (`docs/ade-ags/bench/*real*.json`): cada passo traz `p=` e `fim p=`, e a rodada
 *    tem um veredito VERIFICADO pela página (`criterionOk`). É de onde vem o «acerto»;
 *  - o `decision_shadow_log` do app (`point = 'browser_step' | 'browser_vision'`): centenas de consultas reais, mas SEM
 *    veredito — só mostra a distribuição de p, a concordância entre as perguntas, erros e latência.
 * O log guarda só a MENOR probabilidade da consulta (operação × alvo) e o rótulo do `concluido` sem a probabilidade; as
 * consultas feitas a partir desta versão guardam também a probabilidade de cada pergunta (ver `decision_note` em `browse.rs`).
 */

/** O que a calibração lê de uma rodada do benchmark. */
export interface CalRun {
  id: string;
  outcome: string;
  /** O critério de sucesso vale na página (verificado fora do piloto). */
  criterionOk: boolean;
  forbidden?: boolean;
  report?: string;
}

export interface Corpus {
  /** Um passo que o piloto EXECUTOU: a menor p da consulta, a p do «fim», e se a rodada acabou certa. */
  steps: { p: number; fim: number | null; good: boolean }[];
  /** O piloto deu o objetivo por atingido: pela pergunta direta (`fim p`) ou pela operação `done`. */
  dones: { p: number; via: "direta" | "operacao"; good: boolean }[];
  /** O piloto parou por falta de certeza: a p do passo que não executou e se a página já cumpria o critério. */
  stops: { p: number; alreadyDone: boolean }[];
  /** A reserva visual: p de «existe», confiança da caixa, se tocou, e se a rodada acabou certa. */
  photos: { found: number; conf: number; acted: boolean; good: boolean }[];
}

/** Tira rodadas repetidas (os arquivos «consolidado» copiam as partes): a mesma tarefa com o mesmo relatório conta uma vez. Pura. */
export function dedupeRuns<T extends CalRun>(runs: T[]): T[] {
  const seen = new Set<string>();
  return runs.filter((run) => {
    const key = `${run.id}|${run.report ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const STEP = /^\d+\. (?!objetivo|concluído|sem caminho|recusou|falhou)(.*)\(p=([\d.]+)(?:, fim p=([\d.]+))?/;
const DIRECT = /objetivo atingido \(pergunta direta p=([\d.]+)\)/;
const OP_DONE = /^\d+\. concluído \(p=([\d.]+)/;
const PHOTO = /existe p=([\d.]+), caixa conf=([\d.]+)/;
const UNSURE = /não tem certeza do próximo passo \((\w+)(?: \w+)?, p=([\d.]+)/;

/** As amostras de um conjunto de rodadas, lidas do texto do relatório do `act`. Pura. */
export function corpusFrom(runs: CalRun[]): Corpus {
  const corpus: Corpus = { steps: [], dones: [], stops: [], photos: [] };
  for (const run of runs) {
    const good = run.criterionOk && !run.forbidden;
    for (const line of (run.report ?? "").split("\n")) {
      const photo = PHOTO.exec(line);
      if (photo) {
        corpus.photos.push({ found: Number(photo[1]), conf: Number(photo[2]), acted: line.includes("tocou pela foto"), good });
        continue;
      }
      const direct = DIRECT.exec(line);
      if (direct) { corpus.dones.push({ p: Number(direct[1]), via: "direta", good }); continue; }
      const op = OP_DONE.exec(line);
      if (op) { corpus.dones.push({ p: Number(op[1]), via: "operacao", good }); continue; }
      const step = STEP.exec(line);
      if (step) corpus.steps.push({ p: Number(step[2]), fim: step[3] !== undefined ? Number(step[3]) : null, good });
    }
    const unsure = UNSURE.exec(run.report ?? "");
    if (unsure) corpus.stops.push({ p: Number(unsure[2]), alreadyDone: run.criterionOk });
  }
  return corpus;
}

// ── MIN_PROBABILITY ─────────────────────────────────────────────────

export interface BandRow { from: number; to: number; executed: number; executedGood: number; stops: number; stopsAlreadyDone: number }

export const P_BANDS = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

/** Por faixa de p: quantos passos o piloto executou (e quantos eram de rodadas certas) e quantas vezes parou. Pura. */
export function probabilityBands(corpus: Corpus, bands = P_BANDS): BandRow[] {
  return bands.slice(0, -1).map((from, i) => {
    const to = bands[i + 1];
    const inBand = (p: number) => p >= from && p < to;
    const steps = corpus.steps.filter((s) => inBand(s.p));
    const stops = corpus.stops.filter((s) => inBand(s.p));
    return { from, to, executed: steps.length, executedGood: steps.filter((s) => s.good).length, stops: stops.length, stopsAlreadyDone: stops.filter((s) => s.alreadyDone).length };
  });
}

/**
 * Para cada limite t: quantos dos passos executados cairiam abaixo dele (o piloto pararia) e quantas das paradas reais
 * passariam a executar. «Perdidos certos» = passos de rodadas certas que o limite barraria. Pura.
 */
export function probabilityCurve(corpus: Corpus, thresholds: number[]): { t: number; blockedSteps: number; blockedGood: number; releasedStops: number; releasedAlreadyDone: number }[] {
  return thresholds.map((t) => ({
    t,
    blockedSteps: corpus.steps.filter((s) => s.p < t).length,
    blockedGood: corpus.steps.filter((s) => s.p < t && s.good).length,
    releasedStops: corpus.stops.filter((s) => s.p >= t).length,
    releasedAlreadyDone: corpus.stops.filter((s) => s.p >= t && s.alreadyDone).length,
  }));
}

// ── MIN_GOAL_DONE ───────────────────────────────────────────────────

export interface DoneRow { t: number; accepted: number; falseDone: number; missed: number }

/**
 * Para cada limite t da pergunta direta: dos «feito» da pergunta direta, quantos passariam (`accepted`), quantos deles eram
 * falsos e quantos verdadeiros ficariam de fora (`missed`). Só conta a pergunta direta: a operação `done` tem outro limite
 * (`MIN_PROBABILITY`) e é onde mora o falso «feito» medido. Pura.
 */
export function goalDoneCurve(corpus: Corpus, thresholds: number[]): DoneRow[] {
  const direct = corpus.dones.filter((d) => d.via === "direta");
  return thresholds.map((t) => {
    const accepted = direct.filter((d) => d.p >= t);
    return { t, accepted: accepted.length, falseDone: accepted.filter((d) => !d.good).length, missed: direct.filter((d) => d.p < t && d.good).length };
  });
}

/** A maior `fim p` entre os passos em que o piloto NÃO concluiu: o piso abaixo do qual nenhum limite faria diferença. Pura. */
export function highestNonDoneFim(corpus: Corpus): number | null {
  const fims = corpus.steps.map((s) => s.fim).filter((v): v is number => v !== null);
  return fims.length > 0 ? Math.max(...fims) : null;
}

// ── MIN_FOUND ───────────────────────────────────────────────────────

export interface PhotoRow { found: number; conf: number; passed: number; passedGood: number }

/** Por par de limites (existe, confiança da caixa): quantas fotos passariam e quantas eram de rodadas certas. Pura. */
export function photoCurve(corpus: Corpus, pairs: [number, number][]): PhotoRow[] {
  return pairs.map(([found, conf]) => {
    const passed = corpus.photos.filter((p) => p.found >= found && p.conf >= conf);
    return { found, conf, passed: passed.length, passedGood: passed.filter((p) => p.good).length };
  });
}

// ── O log de sombra ─────────────────────────────────────────────────

/** Uma linha de `decision_shadow_log` do ponto `browser_step`. */
export interface LogRow { decision: string | null; probability: number | null; latencyMs: number | null; error: string | null; inputTokens: number | null }

export interface LogStats {
  rows: number;
  errors: number;
  answered: number;
  bands: { from: number; to: number; n: number }[];
  latency: { p50: number; p95: number } | null;
  inputTokensMedian: number | null;
  /** O `concluido` (sim/não) contra a operação escolhida ser `done`. */
  agreement: { yesDone: number; yesOther: number; noDone: number; noOther: number };
  /** As consultas que já trazem a probabilidade de cada pergunta (`|p:` no rótulo): o que permite calibrar por pergunta. */
  withPerQuestion: number;
}

function rank(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Resume o log: distribuição de p, latência, erros e a concordância entre perguntas. Pura. */
export function logStats(rows: LogRow[], bands = P_BANDS): LogStats {
  const answered = rows.filter((r) => !r.error && r.probability !== null);
  const latencies = answered.map((r) => r.latencyMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const tokens = answered.map((r) => r.inputTokens).filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
  const agreement = { yesDone: 0, yesOther: 0, noDone: 0, noOther: 0 };
  for (const row of answered) {
    const goal = /concluido=(yes|no)/.exec(row.decision ?? "")?.[1];
    const op = /operacao=(\w+)/.exec(row.decision ?? "")?.[1];
    if (!goal || !op) continue;
    const key = `${goal}${op === "done" ? "Done" : "Other"}` as keyof typeof agreement;
    agreement[key] += 1;
  }
  return {
    rows: rows.length,
    errors: rows.filter((r) => r.error).length,
    answered: answered.length,
    bands: bands.slice(0, -1).map((from, i) => ({ from, to: bands[i + 1], n: answered.filter((r) => (r.probability as number) >= from && (r.probability as number) < bands[i + 1]).length })),
    latency: latencies.length > 0 ? { p50: rank(latencies, 0.5), p95: rank(latencies, 0.95) } : null,
    inputTokensMedian: tokens.length > 0 ? rank(tokens, 0.5) : null,
    agreement,
    withPerQuestion: rows.filter((r) => (r.decision ?? "").includes("|p:")).length,
  };
}

/** As probabilidades por pergunta de um rótulo `…|p:alvo_click=0.80,concluido=0.93,operacao=0.90`. Pura. */
export function perQuestion(decision: string | null): Record<string, number> {
  const tail = (decision ?? "").split("|p:")[1];
  if (!tail) return {};
  return Object.fromEntries(tail.split(",").flatMap((pair) => {
    const [name, value] = pair.split("=");
    const n = Number(value);
    return name && Number.isFinite(n) ? [[name, n] as [string, number]] : [];
  }));
}

// ── O relatório ─────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((100 * a) / b)}%`);
const range = (b: { from: number; to: number }) => `${b.from.toFixed(1)}–${Math.min(b.to, 1).toFixed(1)}`;

/** O Markdown da calibração. Pura. */
export function renderCalibration(input: { runs: number; corpus: Corpus; log: LogStats | null; vision: LogStats | null; limits: { minProbability: number; minGoalDone: number; minFound: number; minBox: number } }): string {
  const { corpus, log, vision, limits } = input;
  const out: string[] = [];
  out.push(`Amostra: ${input.runs} rodadas reais únicas · ${corpus.steps.length} passos executados · ${corpus.stops.length} paradas «sem certeza» · ${corpus.dones.length} «feito» · ${corpus.photos.length} fotos.`, "");

  out.push(`### MIN_PROBABILITY = ${limits.minProbability} (a operação/alvo escolhidos)`, "");
  out.push("| p | passos executados | de rodadas certas | paradas «sem certeza» | …com o critério já cumprido |", "|---|---|---|---|---|");
  for (const row of probabilityBands(corpus)) out.push(`| ${range(row)} | ${row.executed} | ${pct(row.executedGood, row.executed)} | ${row.stops} | ${row.stopsAlreadyDone} |`);
  out.push("", "| limite | passos barrados | …de rodadas certas | paradas liberadas | …com o critério já cumprido |", "|---|---|---|---|---|");
  for (const row of probabilityCurve(corpus, [0.3, 0.35, 0.4, 0.45, 0.5, 0.6])) out.push(`| ${row.t.toFixed(2)} | ${row.blockedSteps} | ${row.blockedGood} | ${row.releasedStops} | ${row.releasedAlreadyDone} |`);

  out.push("", `### MIN_GOAL_DONE = ${limits.minGoalDone} (a pergunta direta «o objetivo já foi atingido?»)`, "");
  const gap = highestNonDoneFim(corpus);
  out.push(`Maior \`fim p\` entre os passos em que o piloto NÃO concluiu: ${gap === null ? "—" : gap.toFixed(2)}.`, "");
  out.push("| limite | «feito» aceitos | falsos | verdadeiros deixados de fora |", "|---|---|---|---|");
  for (const row of goalDoneCurve(corpus, [0.5, 0.6, 0.7, 0.75, 0.8, 0.9])) out.push(`| ${row.t.toFixed(2)} | ${row.accepted} | ${row.falseDone} | ${row.missed} |`);
  const viaOp = corpus.dones.filter((d) => d.via === "operacao");
  out.push("", `Pela operação \`done\` (limite = MIN_PROBABILITY): ${viaOp.length} «feito», ${viaOp.filter((d) => !d.good).length} falso(s) — p ${viaOp.filter((d) => !d.good).map((d) => d.p.toFixed(2)).join(", ") || "—"}.`);

  out.push("", `### MIN_FOUND = ${limits.minFound} e confiança da caixa = ${limits.minBox} (reserva visual)`, "");
  out.push("| existe ≥ | caixa ≥ | fotos que passariam | de rodadas certas |", "|---|---|---|---|");
  for (const row of photoCurve(corpus, [[0.5, 0.5], [0.6, 0.6], [0.7, 0.6], [0.8, 0.6], [0.6, 0.7], [0.8, 0.8]])) out.push(`| ${row.found.toFixed(2)} | ${row.conf.toFixed(2)} | ${row.passed} | ${row.passedGood} |`);

  for (const [title, stats] of [["browser_step", log], ["browser_vision", vision]] as const) {
    if (!stats) continue;
    out.push("", `### decision_shadow_log · ${title}`, "");
    out.push(`${stats.rows} consultas, ${stats.errors} com erro, ${stats.answered} respondidas${stats.latency ? ` · latência p50 ${stats.latency.p50} ms, p95 ${stats.latency.p95} ms` : ""}${stats.inputTokensMedian ? ` · ${stats.inputTokensMedian} tokens de entrada (mediana)` : ""}. Já trazem p por pergunta: ${stats.withPerQuestion}.`, "");
    out.push("| p (a menor da consulta) | consultas |", "|---|---|");
    for (const band of stats.bands) out.push(`| ${range(band)} | ${band.n} |`);
    const a = stats.agreement;
    if (a.yesDone + a.yesOther + a.noDone + a.noOther > 0) {
      out.push("", "| | operação = done | outra operação |", "|---|---|---|", `| concluido = sim | ${a.yesDone} | ${a.yesOther} |`, `| concluido = não | ${a.noDone} | ${a.noOther} |`);
    }
  }
  return out.join("\n");
}
