import { describe, expect, it } from "vitest";

import { POINT_MODE, shadowSummary } from "@/features/settings/decisionsModel";

const point = (over: Partial<Parameters<typeof shadowSummary>[0][number]> = {}) => ({
  total: 10, compared: 10, agreementRate: 0.9, p50Ms: 100, p95Ms: 300, errorRate: 0, ...over,
});

describe("shadowSummary (cartão do modo sombra)", () => {
  it("sem nada medido, tudo vazio", () => {
    expect(shadowSummary([])).toEqual({ agreement: null, p50Ms: null, p95Ms: null, errorRate: null, sample: 0 });
  });

  it("concordância pesa pelos comparados; erros pelo total; latência é a do pior ponto", () => {
    const s = shadowSummary([
      point({ compared: 30, agreementRate: 1, total: 30, errorRate: 0, p50Ms: 80, p95Ms: 200 }),
      point({ compared: 10, agreementRate: 0.6, total: 10, errorRate: 0.5, p50Ms: 120, p95Ms: null }),
    ]);
    expect(s.agreement).toBeCloseTo(0.9);
    expect(s.errorRate).toBeCloseTo(0.125);
    expect([s.p50Ms, s.p95Ms, s.sample]).toEqual([120, 200, 40]);
  });

  it("pontos sem heurística local (piloto e visão) ficam fora da concordância, mas contam erros e latência", () => {
    // O painel do usuário em 2026-11-05: 203 consultas visuais do computer use (sem heurística, nunca "concordam")
    // e 4 do delivery_gate, 2 iguais. Antes o cartão mostrava 1% de concordância em 199 amostras.
    const s = shadowSummary([
      point({ point: "browser_vision", total: 203, compared: 195, agreementRate: 0, errorRate: 8 / 203, p50Ms: 576, p95Ms: 1469 }),
      point({ point: "delivery_gate", total: 4, compared: 4, agreementRate: 0.5, errorRate: 0, p50Ms: 332, p95Ms: 491 }),
    ]);
    expect(s.agreement).toBeCloseTo(0.5);
    expect(s.sample).toBe(4);
    expect(s.errorRate).toBeCloseTo(8 / 207);
    expect([s.p50Ms, s.p95Ms]).toEqual([576, 1469]);
  });
});

describe("POINT_MODE", () => {
  it("os nove pontos têm modo, e os do navegador decidem", () => {
    expect(Object.keys(POINT_MODE)).toHaveLength(9);
    expect(POINT_MODE.browser_step).toBe("decide");
    expect(POINT_MODE.turn_routing).toBe("suggest");
  });
});
