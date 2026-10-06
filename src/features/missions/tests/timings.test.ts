import { describe, expect, it } from "vitest";

import { formatDuration, shareOf, testStatsView } from "../timings";

describe("formatDuration", () => {
  it("mostra décimos abaixo de 10 s, segundos até 1 min e depois minutos e horas", () => {
    expect(formatDuration(800)).toBe("0,8 s");
    expect(formatDuration(9_400)).toBe("9,4 s");
    expect(formatDuration(12_000)).toBe("12 s");
    expect(formatDuration(65_000)).toBe("1 min 05 s");
    expect(formatDuration(17 * 60_000 + 9_000)).toBe("17 min 09 s");
    expect(formatDuration(3_900_000)).toBe("1 h 05 min");
  });
  it("não quebra com valores inválidos", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(-5)).toBe("0 s");
    expect(formatDuration(Number.NaN)).toBe("0 s");
  });
});

describe("shareOf", () => {
  it("é a porcentagem do total, limitada a 100", () => {
    expect(shareOf(30_000, 120_000)).toBe(25);
    expect(shareOf(200_000, 120_000)).toBe(100);
    expect(shareOf(1, 0)).toBe(0);
  });
});

describe("testStatsView", () => {
  it("sem testes na missão não mostra nada", () => {
    expect(testStatsView(undefined, 60_000)).toBeNull();
    expect(testStatsView(null, 60_000)).toBeNull();
    expect(testStatsView({ runs: 0, totalMs: 0, cacheHits: 0, affectedRuns: 0 }, 60_000)).toBeNull();
  });
  it("resume tempo, parcela da missão, pulados por cache e só-afetados", () => {
    expect(testStatsView({ runs: 5, totalMs: 30_000, cacheHits: 2, affectedRuns: 3 }, 120_000)).toEqual({
      time: "30 s", share: 25, skipped: 2, affected: 3, runs: 5,
    });
  });
  it("sem tempo total da missão não inventa a parcela", () => {
    expect(testStatsView({ runs: 1, totalMs: 4_000, cacheHits: 0, affectedRuns: 0 }, null)?.share).toBeNull();
  });
});
