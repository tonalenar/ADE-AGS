import { describe, expect, it } from "vitest";

import { formatResult, type PilotResult } from "../jevPilot";
import { Ring, percentile, statsBetween, windowLine, type Beat } from "../windowBeat";

const beat = (t: number, lag: number, hidden = false): Beat => ({ t, lag, hidden });

describe("batimento do renderizador", () => {
  it("percentil por posto mais próximo; vazio dá 0", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v.reverse(), 50)).toBe(50);
  });

  it("estatística só das amostras dentro do intervalo, com tempo oculto", () => {
    const beats = [beat(0, 900), beat(100, 5), beat(200, 20, true), beat(300, 400, true), beat(400, 10), beat(900, 800)];
    expect(statsBetween(beats, 100, 400, 2)).toEqual({ lagMaxMs: 400, lagP95Ms: 400, samples: 4, hiddenMs: 200, timeouts: 2 });
    expect(statsBetween(beats, 5000, 6000)).toEqual({ lagMaxMs: 0, lagP95Ms: 0, samples: 0, hiddenMs: 0, timeouts: 0 });
  });

  it("o anel descarta o mais antigo", () => {
    const ring = new Ring(3);
    for (let i = 0; i < 5; i++) ring.push(beat(i, i));
    expect(ring.all().map((b) => b.t)).toEqual([2, 3, 4]);
  });

  it("formato do relatório do act", () => {
    const w = { lagMaxMs: 1200, lagP95Ms: 300, samples: 50, hiddenMs: 0, timeouts: 0 };
    expect(windowLine(w)).toBe("janela: lag máx 1200 ms (p95 300 ms)");
    expect(windowLine({ ...w, hiddenMs: 3000, timeouts: 1 })).toBe("janela: lag máx 1200 ms (p95 300 ms), oculta 3000 ms, 1 timeout(s) do puente");
    const result: PilotResult = { outcome: "done", steps: [], note: "ok", finalSnapshot: "page", window: w };
    const text = formatResult("meta", result);
    expect(text).toContain("janela: lag máx 1200 ms (p95 300 ms)");
    expect(text).toContain(`JANELA: ${JSON.stringify(w)}`);
    expect(formatResult("meta", { ...result, window: undefined })).not.toContain("janela:");
  });
});
