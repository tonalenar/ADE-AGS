import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { agentReads, percent, suggestedIds, usageVerdict, type CleanupCandidate, type UsageReport } from "../memoryUsage";

const report = (extra: Partial<UsageReport> = {}): UsageReport => ({
  total: 10, injected: 4, searches: 4, searchesWithHits: 3, opens: 2, indexReads: 1, distinctAgents: 3,
  topRead: [], neverRead: 50, activeEntries: 100, missions: [], ...extra,
});

describe("uso da memória", () => {
  it("só conta como leitura o que o agente pediu, não a injeção do app", () => {
    expect(agentReads(report())).toBe(7);
    expect(agentReads(report({ searches: 0, opens: 0, indexReads: 0 }))).toBe(0);
  });

  it("o veredito separa sem dados, nunca lida, fraca e ativa", () => {
    expect(usageVerdict(null)).toBe("unknown");
    expect(usageVerdict(report({ total: 0 }))).toBe("unknown");
    expect(usageVerdict(report({ searches: 0, opens: 0, indexReads: 0 }))).toBe("unused");
    expect(usageVerdict(report({ searches: 8, searchesWithHits: 1 }))).toBe("weak");
    expect(usageVerdict(report({ neverRead: 95 }))).toBe("weak");
    expect(usageVerdict(report())).toBe("active");
  });

  it("percentual sem base é nulo", () => {
    expect(percent(1, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33);
  });

  it("sugere marcar duplicadas, chaves de teste e o que tem mais de um motivo, não só o palpite do Jev", () => {
    const c = (entryId: string, reasons: string[]): CleanupCandidate => ({ entryId, scope: "workspace", missionId: null, key: entryId, kind: "note", bodyPreview: "", reasons });
    const list = [c("a", ["duplicada de x"]), c("b", ["chave de teste"]), c("c", ["o Jev rejeitaria"]), c("d", ["o Jev rejeitaria", "outro"])];
    expect(suggestedIds(list)).toEqual(["a", "b", "d"]);
  });
});
