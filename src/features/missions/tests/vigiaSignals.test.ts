import { describe, expect, it } from "vitest";

import type { StructuredSnapshot } from "@/features/terminal/structuredState";
import { CONTEXT_REPORT_MS, contextDue, contextNudge, contextPressure, contextStuck, repeatKey, repeatStuck } from "../vigiaSignals";

function snapshot(over: Partial<StructuredSnapshot> = {}): StructuredSnapshot {
  return { tabId: "t1", agentId: "claude-code", mode: "veto", phase: "working", stale: false, tools: [], question: null, endsWithQuestion: false, turnStartedAt: 100, ...over };
}

const repeat = { key: "abc", name: "Bash", summary: "cargo test", count: 3, step: 3, atMs: 5 };

describe("sinais do canal no Vigia", () => {
  it("a repetição tem uma chave por aba, turno, chamada e degrau", () => {
    expect(repeatKey("t1", snapshot())).toBeNull();
    expect(repeatKey("t1", snapshot({ repeat }))).toBe("t1:100:abc:3");
    expect(repeatKey("t1", snapshot({ repeat: { ...repeat, step: 5, count: 5 } }))).toBe("t1:100:abc:5");
    expect(repeatKey("t1", snapshot({ repeat, turnStartedAt: 200 }))).toBe("t1:200:abc:3");
  });

  it("o aviso da repetição diz a chamada e quantas vezes", () => {
    const text = repeatStuck("Codex Backend", snapshot({ repeat }));
    expect(text).toContain("3 vezes");
    expect(text).toContain('"Bash cargo test"');
  });

  it("a pressão de contexto soma a âncora real e a estimativa de 4 caracteres por token", () => {
    expect(contextPressure(snapshot())).toBeNull();
    expect(contextPressure(snapshot({ context: { anchorTokens: 150_000, extraChars: 40_000, windowTokens: 200_000, model: null } }))).toBeCloseTo(0.8);
    expect(contextPressure(snapshot({ context: { anchorTokens: 150_000, extraChars: 0, windowTokens: 0, model: null } }))).toBeNull();
  });

  it("o contexto avisa acima de 80% e no máximo uma vez por hora por terminal", () => {
    expect(contextDue(null, undefined, 0)).toBe(false);
    expect(contextDue(0.79, undefined, 0)).toBe(false);
    expect(contextDue(0.8, undefined, 0)).toBe(true);
    expect(contextDue(0.9, 1_000, 1_000 + CONTEXT_REPORT_MS - 1)).toBe(false);
    expect(contextDue(0.9, 1_000, 1_000 + CONTEXT_REPORT_MS)).toBe(true);
    expect(contextStuck("Dev", 0.856)).toContain("~86%");
    expect(contextNudge("Dev", 0.856)).toContain('ags peer ask "Dev"');
  });
});
