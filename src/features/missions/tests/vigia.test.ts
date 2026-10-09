/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { VIGIA_COOLDOWN_MS, VIGIA_IDLE_MS, idleCandidates, vigiaAgentFor, vigiaBriefing, vigiaCycle } from "../vigia";
import { leadBriefing } from "../terminals";

describe("Vigia", () => {
  it("usa o modelo barato do provedor do Orquestrador", () => {
    expect(vigiaAgentFor("claude-code", ["claude-code", "codex"])).toEqual({ agentId: "claude-code", model: "haiku", effort: "medium" });
    expect(vigiaAgentFor("codex", ["claude-code", "codex"])).toEqual({ agentId: "codex", model: "gpt-6-luna", effort: "max" });
    // Outro provedor: o primeiro barato instalado; nenhum instalado: sem Vigia.
    expect(vigiaAgentFor("antigravity", ["codex"])?.agentId).toBe("codex");
    expect(vigiaAgentFor("antigravity", ["antigravity"])).toBeNull();
  });

  it("só aponta quem está sem saída há tempo e não foi reportado há pouco, nunca ele mesmo", () => {
    const now = 1_000_000;
    const tabs = [{ id: "lead", title: "Orquestrador" }, { id: "a", title: "Backend" }, { id: "b", title: "QA" }, { id: "v", title: "Vigia" }];
    const out: Record<string, number> = { lead: now - 1000, a: now - VIGIA_IDLE_MS - 1, b: now - VIGIA_IDLE_MS - 1, v: now - 999_999 };
    const poked = new Map([["b", now - 1000]]);
    expect(idleCandidates(tabs, "v", now, (id) => out[id], poked).map((t) => t.title)).toEqual(["Backend"]);
    poked.set("b", now - VIGIA_COOLDOWN_MS);
    expect(idleCandidates(tabs, "v", now, (id) => out[id], poked).map((t) => t.title)).toEqual(["Backend", "QA"]);
  });

  it("o briefing diz que ele não implementa e como avisar; o ciclo cita os nomes", () => {
    const text = vigiaBriefing("M", "Orquestrador", ["Backend", "QA"]);
    expect(text).toContain("NÃO implementa");
    expect(text).toContain('ags peer tell "Orquestrador" "[Vigia]');
    expect(text).toContain("Backend, QA");
    expect(vigiaCycle(["Backend"])).toContain("CICLO DO VIGIA");
  });

  it("o Orquestrador só é avisado do Vigia quando ele existe", () => {
    expect(leadBriefing({ title: "T", objective: "O" }, [], "", "", undefined, [], true)).toContain("[Vigia]");
    expect(leadBriefing({ title: "T", objective: "O" }, [])).not.toContain("[Vigia]");
  });
});
