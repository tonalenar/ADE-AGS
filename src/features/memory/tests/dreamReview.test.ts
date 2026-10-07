import { describe, expect, it, vi } from "vitest";
import { approveDream, diffLines, purgeConfirmed, reviewableDreams } from "../dreamReview";
import type { MemoryDream, MemoryReviewItem } from "../types";

const item = (key: string, over: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({
  entryId: `e-${key}`, revision: 1, key, kind: "note", body: key, priority: 1,
  evidence: { runId: "r", taskId: null, factId: null, actorKind: "worker", reason: "run r" },
  highValue: false, score: 10, ...over,
});
const dream = (over: Partial<MemoryDream> = {}): MemoryDream => ({ dreamId: "d", runId: "r", createdAt: 1, status: "done", proposals: [item("a")], markdownDiff: "", questions: [], ...over });

describe("revisao do sonho", () => {
  it("purge exige digitar a chave exata", () => {
    expect(purgeConfirmed("k", "k")).toBe(true);
    expect(purgeConfirmed("x", "k")).toBe(false);
    expect(purgeConfirmed("", "")).toBe(false);
  });
  it("so mostra sonhos prontos com propostas", () => {
    const out = reviewableDreams([dream({ dreamId: "a", createdAt: 1 }), dream({ dreamId: "b", createdAt: 5 }), dream({ dreamId: "c", status: "running" }), dream({ dreamId: "e", proposals: [] })]);
    expect(out.map((d) => d.dreamId)).toEqual(["b", "a"]);
  });
  it("classifica linhas do diff", () => {
    expect(diffLines("--- a\n+++ b\n+x\n-y\n z\n").map((l) => l.kind)).toEqual(["ctx", "ctx", "add", "del", "ctx"]);
  });
  it("aprovar o grupo respeita A3: contradicao, exclusao e duplicata ficam fora", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const d = dream({ proposals: [item("a"), item("c", { contradicts: { entryId: "x", key: "o" } }), item("x", { operation: "delete" }), item("d", { duplicateOf: { entryId: "y", key: "o" } })] });
    const out = await approveDream(d, decide);
    expect(decide.mock.calls.map((c) => c[0])).toEqual(["e-a"]);
    expect([out.skippedContradictions, out.skippedDeletions, out.skippedDuplicates]).toEqual([["c"], ["x"], ["d"]]);
  });
});

describe("ator dreamer", () => {
  it("propostas do dreamer sao tratadas como de agente (aviso de prioridade, sem confianca extra)", async () => {
    const { asksHighPriority } = await import("../bulkReview");
    const d = item("a", { priority: 3, evidence: { runId: "r", taskId: null, factId: null, actorKind: "dreamer", reason: "run r" } });
    expect(asksHighPriority(d)).toBe(true);
  });
  it("existe texto de ator dreamer nos 3 idiomas", async () => {
    const [en, es, pt] = await Promise.all([import("../../../i18n/locales/en.json"), import("../../../i18n/locales/es.json"), import("../../../i18n/locales/pt-BR.json")]);
    for (const m of [en, es, pt] as unknown as { default: Record<string, string> }[]) { const l = m.default; expect(l["memoryReview.actor.dreamer"]).toBeTruthy(); }
  });
});
