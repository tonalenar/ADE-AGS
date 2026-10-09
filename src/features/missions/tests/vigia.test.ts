/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { VIGIA_COOLDOWN_MS, VIGIA_IDLE_MS, idleCandidates, vigiaAgentFor } from "../vigia";
import { leadBriefing } from "../terminals";

describe("Vigia (em segundo plano, sem terminal)", () => {
  it("usa o modelo barato do provedor do Orquestrador", () => {
    expect(vigiaAgentFor("claude-code", ["claude-code", "codex"])).toEqual({ agentId: "claude-code", model: "haiku", effort: "medium" });
    expect(vigiaAgentFor("codex", ["claude-code", "codex"])).toEqual({ agentId: "codex", model: "gpt-6-luna", effort: "max" });
    expect(vigiaAgentFor("antigravity", ["codex"])?.agentId).toBe("codex");
    expect(vigiaAgentFor("antigravity", ["antigravity"])).toBeNull();
  });

  it("só aponta quem está sem saída há tempo e não foi reportado há pouco", () => {
    const now = 1_000_000;
    const tabs = [{ id: "lead" }, { id: "a" }, { id: "b" }];
    const out: Record<string, number> = { lead: now - 1000, a: now - VIGIA_IDLE_MS - 1, b: now - VIGIA_IDLE_MS - 1 };
    const poked = new Map([["b", now - 1000]]);
    expect(idleCandidates(tabs, now, (id) => out[id], poked).map((t) => t.id)).toEqual(["a"]);
    poked.set("b", now - VIGIA_COOLDOWN_MS);
    expect(idleCandidates(tabs, now, (id) => out[id], poked).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("o Orquestrador só é avisado do Vigia quando ele existe", () => {
    expect(leadBriefing({ title: "T", objective: "O" }, [], "", "", undefined, [], true)).toContain("[Vigia]");
    expect(leadBriefing({ title: "T", objective: "O" }, [])).not.toContain("[Vigia]");
  });
});
