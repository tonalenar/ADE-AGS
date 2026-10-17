import { describe, expect, it } from "vitest";

import { RELEASE_LIMITS, expectsFor, gateCheck, groupMetrics, parseActReport, regex, all, any, not, text, url, emptyPhases, sprt, wilson, type TaskRun } from "../../../../scripts/bench/core";
import { runSimTask } from "../../../../scripts/bench/sim";
import { TASKS } from "../../../../scripts/bench/tasks";

/**
 * O PORTÃO do benchmark (plano v2, Fase 7). Duas camadas:
 *  1. `gateCheck`: os limites de LIBERAÇÃO (sucesso ≥ 90%, falso «feito» ≤ 2%, passo p50 ≤ 700 ms, 0 travamentos). A rodada REAL
 *     manual os aplica antes de cada instalador (`jev-bench.ts --real --gate`).
 *  2. Um piso de REGRESSÃO no simulador, que roda no CI: o que já passa hoje tem de continuar passando. Quando uma fase do
 *     plano conserta uma tarefa, SOBE o piso (`CI_FLOOR`) no mesmo commit.
 */

const run = (patch: Partial<TaskRun> = {}): TaskRun => ({
  id: "X", outcome: "done", criterionOk: true, forbidden: false, steps: 2, autoFills: 0, photos: 0, totalMs: 3000,
  stepMs: [500, 600], phases: emptyPhases(), timing: "measured", finalUrl: "", ...patch,
});

describe("limites de liberação", () => {
  it("uma rodada boa passa", () => {
    expect(gateCheck(groupMetrics(Array.from({ length: 20 }, () => run()))).ok).toBe(true);
  });

  it("reprova por sucesso, falso «feito», passo lento, travamento e «verificado» errado, dizendo qual", () => {
    const bad = groupMetrics([
      ...Array.from({ length: 8 }, () => run()),
      run({ criterionOk: false }),
      run({ criterionOk: false, verdict: "verified" }),
    ]);
    const { ok, failures } = gateCheck(bad);
    expect(ok).toBe(false);
    expect(failures.join(" ")).toMatch(/sucesso 80%/);
    expect(failures.join(" ")).toMatch(/falso «feito»/);
    expect(failures.join(" ")).toMatch(/verificado/);
    const slow = gateCheck(groupMetrics([run({ stepMs: [900, 1000] })]));
    expect(slow.failures.join(" ")).toMatch(/mediana por passo/);
    const hang = gateCheck(groupMetrics([run({ windowHang: true })]));
    expect(hang.failures.join(" ")).toMatch(/travamento/);
  });

  it("sem rodadas não passa", () => {
    expect(gateCheck(groupMetrics([])).ok).toBe(false);
  });

  it("os limites são os do plano", () => {
    expect(RELEASE_LIMITS).toEqual({ minSuccessRate: 0.9, maxFalseDoneRate: 0.02, maxStepP50Ms: 700, maxWindowHangs: 0, maxVerifiedWrong: 0 });
  });
});

describe("--expect a partir do critério", () => {
  it("texto, URL, regex, e/não viram expectativas; ou/não-de-URL não", () => {
    expect(expectsFor(all(url("/cart"), text("1 item")))).toEqual(["url:/cart", "text:1 item"]);
    expect(expectsFor(regex("removido: (a|b)"))).toEqual(["text:/removido: (a|b)/"]);
    expect(expectsFor(all(text("ok"), not(text("erro"))))).toEqual(["text:ok", "absent:erro"]);
    expect(expectsFor(any(text("a"), text("b")))).toEqual([]);
    expect(expectsFor(not(url("/x")))).toEqual([]);
  });
});

describe("relatório com veredito", () => {
  const head = (label: string) => `act "x": ${label}\nnota\n\nA página agora (o Jev só escolhe onde tocar: confira o resultado):\npage: "L" http://a.test/\n`;
  it("lê FEITO (verificado), FEITO (não verificado) e NÃO CONFERE", () => {
    const a = parseActReport(head("FEITO (verificado)"));
    expect([a.outcome, a.verdict]).toEqual(["done", "verified"]);
    const b = parseActReport(head("FEITO (não verificado)"));
    expect([b.outcome, b.verdict]).toEqual(["done", "unverified"]);
    const c = parseActReport(head("NÃO CONFERE"));
    expect([c.outcome, c.verdict]).toEqual(["unsure", "mismatch"]);
    expect(parseActReport(head("FEITO")).verdict).toBeNull();
  });
  it("«verificado» errado e NÃO CONFERE que pegou entram nas métricas", () => {
    const g = groupMetrics([run({ criterionOk: false, verdict: "verified" }), run({ criterionOk: false, outcome: "unsure", verdict: "mismatch" }), run()]);
    expect(g.verifiedWrong).toBe(1);
    expect(g.caught).toBe(1);
  });
});

/** O piso do simulador no CI. As tarefas L* e N03 passam hoje; o resto é a lista de trabalho das Fases 2–4 (cai da lista quando consertar). */
const CI_FLOOR = {
  mustPass: TASKS.filter((t) => t.sim && (t.id.startsWith("L") || t.id === "N03-busca-lenta-xhr")).map((t) => t.id),
  minSuccessRate: 0.66,
};

describe("piso de regressão no simulador (CI)", () => {
  it("o que já passa continua passando e a taxa do portão não cai", async () => {
    const sim = TASKS.filter((t) => t.sim);
    const runs: TaskRun[] = [];
    for (const task of sim) runs.push(await runSimTask(task, { seed: 1 }));
    const failed = CI_FLOOR.mustPass.filter((id) => {
      const r = runs.find((x) => x.id === id)!;
      return !(r.criterionOk && !r.forbidden);
    });
    expect(failed, `regrediram: ${failed.join(", ")}`).toEqual([]);
    expect(groupMetrics(runs).successRate).toBeGreaterThanOrEqual(CI_FLOOR.minSuccessRate);
  }, 120_000);
});

describe("protocolo J2: intervalo de Wilson e SPRT", () => {
  it("o 100% de amostra pequena não promete 100%", () => {
    const small = wilson(54, 54);
    expect(small.high).toBe(1);
    expect(small.low).toBeGreaterThan(0.92);
    expect(small.low).toBeLessThan(0.94);
    expect(wilson(27, 27).low).toBeLessThan(0.88);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    const half = wilson(50, 100);
    expect(half.low).toBeLessThan(0.5);
    expect(half.high).toBeGreaterThan(0.5);
  });

  it("o SPRT para cedo quando o resultado é claro e pede mais rodadas quando não é", () => {
    expect(sprt(27, 27)).toBe("rodar mais");
    expect(sprt(300, 300)).toBe("atinge");
    expect(sprt(85, 100)).toBe("não atinge");
    expect(sprt(298, 300)).toBe("atinge");
  });
});
