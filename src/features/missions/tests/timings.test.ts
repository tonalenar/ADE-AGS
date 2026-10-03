import { describe, expect, it } from "vitest";

import { formatDuration, shareOf } from "../timings";

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
