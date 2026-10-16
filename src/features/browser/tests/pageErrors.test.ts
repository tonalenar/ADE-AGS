import { describe, expect, it } from "vitest";

import { classifyStall, stallMessage, type PageStallFacts } from "../pageErrors";

const base: PageStallFacts = { timeoutMs: 12_000, hidden: false, loadCount: 3, ready: true, navigatingForMs: null, lagMaxMs: 20 };

describe("causa da página que não respondeu (I5)", () => {
  it("cada causa tem classe e mensagem próprias, e todas dizem o que fazer", () => {
    const cases: [Partial<PageStallFacts>, string, RegExp][] = [
      [{ hidden: true }, "hidden", /oculta ou minimizada.*à frente/s],
      [{ navigatingForMs: 4000 }, "navigating", /navegando.*wait <portal> --idle/s],
      [{ ready: false }, "navigating", /navegando/],
      [{ loadCount: 0 }, "no-runtime", /runtime.*navigate <portal> <url>/s],
      [{ lagMaxMs: 1500 }, "heavy", /pesada.*1500 ms/s],
      [{}, "unknown", /snapshot/],
    ];
    const messages = new Set<string>();
    for (const [facts, kind, text] of cases) {
      const f = { ...base, ...facts };
      expect(classifyStall(f)).toBe(kind);
      expect(stallMessage(f)).toMatch(text);
      messages.add(stallMessage(f).slice(0, 30));
    }
    expect(messages.size).toBeGreaterThanOrEqual(5);
  });

  it("janela oculta vence as outras causas; navegação vence runtime ausente", () => {
    expect(classifyStall({ ...base, hidden: true, loadCount: 0, lagMaxMs: 9000 })).toBe("hidden");
    expect(classifyStall({ ...base, loadCount: 0, navigatingForMs: 100 })).toBe("navigating");
    // navegação pedida há muito tempo e nada de runtime: é runtime ausente, não «carregando»
    expect(classifyStall({ ...base, navigatingForMs: 60_000 })).toBe("no-runtime");
  });

  it("o tempo aparece em segundos", () => {
    expect(stallMessage({ ...base, hidden: true, timeoutMs: 8000 })).toContain("8 s");
  });
});
