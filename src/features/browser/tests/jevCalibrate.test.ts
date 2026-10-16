import { describe, expect, it } from "vitest";

import {
  corpusFrom, dedupeRuns, goalDoneCurve, highestNonDoneFim, logStats, perQuestion, photoCurve, probabilityBands, probabilityCurve, renderCalibration,
  type CalRun,
} from "../../../../scripts/bench/calibrate";

// Plano v2, 4.5 (achado D3): a calibração lê os relatórios reais e o log de sombra; aqui se confere a contagem, não o Jev.

const report = (lines: string[]) => ["act \"g\": FEITO", "", "Passos:", ...lines, "", "A página agora (o Jev só escolhe onde tocar: confira o resultado):"].join("\n");

const RUNS: CalRun[] = [
  { id: "a", outcome: "done", criterionOk: true, report: report(['1. clicou button "Buscar" (p=0.55, fim p=0.10, 400 ms, passo 900 ms)', "2. objetivo atingido (pergunta direta p=0.93)"]) },
  { id: "b", outcome: "done", criterionOk: false, report: report(['1. clicou link "Item" (p=0.92, fim p=0.38, 300 ms, passo 800 ms)', "2. concluído (p=0.83, fim p=0.20, 300 ms)"]) },
  { id: "c", outcome: "unsure", criterionOk: false, report: report(["PAROU (Jev sem certeza)", "O Jev não tem certeza do próximo passo (click e4, p=0.33, fim p=0.10, 300 ms). Continue você."]) },
  { id: "d", outcome: "unsure", criterionOk: true, report: "O Jev não tem certeza do próximo passo (click e2, p=0.36, fim p=0.05, 300 ms)." },
  { id: "e", outcome: "done", criterionOk: true, report: report(["1. tocou pela foto no ponto (10, 20) (existe p=0.95, caixa conf=0.80, 1200 ms)", "2. objetivo atingido (pergunta direta p=0.80)"]) },
];

describe("a amostra dos relatórios reais", () => {
  const corpus = corpusFrom(RUNS);

  it("lê passos, «feito», paradas e fotos do texto do act", () => {
    expect(corpus.steps).toEqual([
      { p: 0.55, fim: 0.1, good: true },
      { p: 0.92, fim: 0.38, good: false },
    ]);
    expect(corpus.dones).toEqual([
      { p: 0.93, via: "direta", good: true },
      { p: 0.83, via: "operacao", good: false },
      { p: 0.8, via: "direta", good: true },
    ]);
    expect(corpus.stops).toEqual([{ p: 0.33, alreadyDone: false }, { p: 0.36, alreadyDone: true }]);
    expect(corpus.photos).toEqual([{ found: 0.95, conf: 0.8, acted: true, good: true }]);
  });

  it("a mesma tarefa com o mesmo relatório conta uma vez (o consolidado copia as partes)", () => {
    expect(dedupeRuns([...RUNS, ...RUNS]).length).toBe(RUNS.length);
    expect(dedupeRuns([RUNS[0], { ...RUNS[0], report: "outro" }]).length).toBe(2);
  });

  it("as faixas de p separam passos executados de paradas", () => {
    const bands = probabilityBands(corpus);
    const at = (from: number) => bands.find((b) => b.from === from)!;
    expect(at(0.3).stops).toBe(2);
    expect(at(0.3).stopsAlreadyDone).toBe(1);
    expect(at(0.5).executed).toBe(1);
    expect(at(0.9).executedGood).toBe(0);
  });

  it("a curva de MIN_PROBABILITY conta o que o limite barra e o que libera", () => {
    const [low, mid, high] = probabilityCurve(corpus, [0.3, 0.4, 0.6]);
    expect(low.releasedStops).toBe(2);
    expect(mid.releasedStops).toBe(0);
    expect(mid.blockedSteps).toBe(0);
    expect(high.blockedSteps).toBe(1);
    expect(high.blockedGood).toBe(1);
  });

  it("a curva de MIN_GOAL_DONE só conta a pergunta direta e acusa o verdadeiro deixado de fora", () => {
    const rows = goalDoneCurve(corpus, [0.5, 0.9]);
    expect(rows[0]).toMatchObject({ accepted: 2, falseDone: 0, missed: 0 });
    expect(rows[1]).toMatchObject({ accepted: 1, falseDone: 0, missed: 1 }); // 0.80 fica de fora
    expect(highestNonDoneFim(corpus)).toBe(0.38);
    expect(highestNonDoneFim({ steps: [], dones: [], stops: [], photos: [] })).toBeNull();
  });

  it("a curva da foto exige as duas certezas", () => {
    const [loose, strict] = photoCurve(corpus, [[0.6, 0.6], [0.6, 0.9]]);
    expect(loose.passed).toBe(1);
    expect(strict.passed).toBe(0);
  });
});

describe("o log de sombra", () => {
  const row = (decision: string | null, probability: number | null, latencyMs = 300, error: string | null = null) => ({ decision, probability, latencyMs, error, inputTokens: 1000 });

  it("resume erros, distribuição, latência e a concordância entre as perguntas", () => {
    const stats = logStats([
      row("concluido=yes;operacao=done", 0.9, 250),
      row("concluido=no;operacao=click", 0.35, 350),
      row("concluido=no;operacao=done", 0.8, 450),
      row(null, null, 800, "timeout"),
    ]);
    expect(stats).toMatchObject({ rows: 4, errors: 1, answered: 3, latency: { p50: 350, p95: 450 }, inputTokensMedian: 1000 });
    expect(stats.agreement).toEqual({ yesDone: 1, yesOther: 0, noDone: 1, noOther: 1 });
    expect(stats.bands.find((b) => b.from === 0.3)!.n).toBe(1);
    expect(stats.withPerQuestion).toBe(0);
  });

  it("lê a probabilidade de cada pergunta quando o rótulo a traz", () => {
    expect(perQuestion("alvo_click=e4;concluido=no;operacao=click|p:alvo_click=0.80,concluido=0.93,operacao=0.90")).toEqual({ alvo_click: 0.8, concluido: 0.93, operacao: 0.9 });
    expect(perQuestion("operacao=done")).toEqual({});
    expect(perQuestion(null)).toEqual({});
    expect(logStats([row("operacao=click|p:operacao=0.9", 0.9)]).withPerQuestion).toBe(1);
  });

  it("o relatório em Markdown traz os limites vigentes e as tabelas", () => {
    const md = renderCalibration({ runs: 5, corpus: corpusFrom(RUNS), log: logStats([row("concluido=yes;operacao=done", 0.9)]), vision: null, limits: { minProbability: 0.4, minGoalDone: 0.75, minFound: 0.6, minBox: 0.6 } });
    expect(md).toContain("MIN_PROBABILITY = 0.4");
    expect(md).toContain("MIN_GOAL_DONE = 0.75");
    expect(md).toContain("MIN_FOUND = 0.6");
    expect(md).toContain("decision_shadow_log · browser_step");
    expect(md).toContain("Maior `fim p`");
  });
});
