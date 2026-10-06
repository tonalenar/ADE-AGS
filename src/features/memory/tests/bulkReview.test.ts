import { describe, expect, it, vi } from "vitest";
import { approveBulk, itemId, normalizeGroups, planBulk, rejectBulk, selectedItems, totalPending, type MissionReviewGroup } from "../bulkReview";
import type { MemoryReviewItem } from "../types";

const item = (key: string, over: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({
  entryId: `e-${key}`, revision: 1, key, kind: "note", body: key, priority: 1,
  evidence: { runId: null, taskId: null, factId: null, actorKind: "worker", reason: null },
  highValue: false, score: 10, ...over,
});
const contra = (key: string) => item(key, { contradicts: { entryId: "x", key: "old" } });
const dup = (key: string) => item(key, { duplicateOf: { entryId: "y", key: "old" } });

describe("bulkReview", () => {
  it("normaliza: sin grupos vacios, ordenado por titulo, contradicciones primero", () => {
    const groups: MissionReviewGroup[] = [
      { missionId: "2", title: "Zeta", items: [item("a")] },
      { missionId: "1", title: "Alfa", items: [dup("d"), contra("c"), item("n")] },
      { missionId: "3", title: "Vazia", items: [] },
    ];
    const out = normalizeGroups(groups);
    expect(out.map((g) => g.title)).toEqual(["Alfa", "Zeta"]);
    expect(out[0].items.map((i) => i.key)).toEqual(["c", "n", "d"]);
    expect(totalPending(out)).toBe(4);
  });

  it("selectedItems respeta ids", () => {
    const groups = normalizeGroups([{ missionId: "1", title: "A", items: [item("a"), item("b")] }]);
    expect(selectedItems(groups, new Set([itemId(item("b"))])).map((i) => i.key)).toEqual(["b"]);
    expect(selectedItems(groups, new Set())).toEqual([]);
  });

  it("planBulk avisa de contradicciones", () => {
    const p = planBulk([item("a"), contra("c"), dup("d")]);
    expect(p).toMatchObject({ total: 3, duplicates: 1, needsWarning: true });
    expect(p.contradictions.map((i) => i.key)).toEqual(["c"]);
    expect(planBulk([item("a")]).needsWarning).toBe(false);
  });

  it("NO acepta contradicciones sin confirmar el aviso", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const out = await approveBulk([item("a"), contra("c")], decide, { acknowledgeContradictions: false });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith("e-a", 1, true);
    expect(out).toEqual({ done: 1, failed: [], skippedContradictions: ["c"], skippedDeletions: [] });
  });

  it("con el aviso confirmado acepta todo", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const out = await approveBulk([item("a"), contra("c")], decide, { acknowledgeContradictions: true });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(out.skippedContradictions).toEqual([]);
  });

  it("un error no interrumpe y se informa", async () => {
    const decide = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const out = await approveBulk([item("a"), item("b")], decide, { acknowledgeContradictions: false });
    expect(out).toMatchObject({ done: 1, failed: ["a"] });
  });

  it("rechazar en masa decide approve=false para todos", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const out = await rejectBulk([item("a"), contra("c")], decide);
    expect(decide.mock.calls.map((c) => c[2])).toEqual([false, false]);
    expect(out.done).toBe(2);
  });

  it("sin items no llama a nada", async () => {
    const decide = vi.fn();
    expect((await approveBulk([], decide, { acknowledgeContradictions: true })).done).toBe(0);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("exclusoes (operation=delete)", () => {
  const del = (key: string) => item(key, { operation: "delete" });
  it("planBulk as lista e exige aviso", () => {
    const p = planBulk([item("a"), del("x")]);
    expect(p.deletions.map((i) => i.key)).toEqual(["x"]);
    expect(p.needsWarning).toBe(true);
  });
  it("sem confirmar o aviso NAO exclui", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const out = await approveBulk([item("a"), del("x")], decide, { acknowledgeContradictions: false });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(out.skippedDeletions).toEqual(["x"]);
  });
  it("confirmado, aceita", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    await approveBulk([del("x")], decide, { acknowledgeContradictions: true });
    expect(decide).toHaveBeenCalledWith("e-x", 1, true);
  });
});
