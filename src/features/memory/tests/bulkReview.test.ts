import { describe, expect, it, vi } from "vitest";
import { approveBulk, asksHighPriority, inboxKeyAction, groupsFromWorkspaceReview, itemId, normalizeGroups, planBulk, rejectBulk, selectedItems, totalPending, type MissionReviewGroup } from "../bulkReview";
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
    expect(out).toEqual({ done: 1, failed: [], skippedContradictions: ["c"], skippedDeletions: [], skippedDuplicates: [] });
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

describe("groupsFromWorkspaceReview", () => {
  const fb = (id: string | null) => (id === null ? "WS" : `m-${id}`);
  it("acepta array", () => {
    const g = groupsFromWorkspaceReview([{ missionId: "1", title: "A", items: [item("a")] }], fb);
    expect(g).toMatchObject([{ missionId: "1", title: "A" }]);
  });
  it("acepta {groups} con grupo sin mision", () => {
    const g = groupsFromWorkspaceReview({ groups: [{ missionId: null, missionTitle: null, items: [item("a")] }, { missionId: "2", missionTitle: null, items: [item("b")] }] }, fb);
    expect(g.map((x) => x.title)).toEqual(["WS", "m-2"]);
  });
  it("descarta basura", () => {
    expect(groupsFromWorkspaceReview(null, fb)).toEqual([]);
    expect(groupsFromWorkspaceReview([null, { missionId: "1" }], fb)).toEqual([]);
  });
});

describe("A3: higiene da aprovacao", () => {
  it("duplicatas ficam fora da aprovacao em massa", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const out = await approveBulk([item("a"), dup("d")], decide, { acknowledgeContradictions: true });
    expect(decide.mock.calls.map((c) => c[0])).toEqual(["e-a"]);
    expect(out.skippedDuplicates).toEqual(["d"]);
  });
  it("aprovar UMA duplicata de forma explicita continua possivel", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    await approveBulk([dup("d")], decide, { acknowledgeContradictions: true, explicit: true });
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it("Enter NUNCA confirma aviso: approve com acknowledge=false", () => {
    expect(inboxKeyAction("Enter", true)).toEqual({ type: "approve", acknowledge: false });
    expect(inboxKeyAction("Enter", false)).toEqual({ type: "none" });
  });
  it("Enter em lote com contradicao/exclusao nao decide a contradicao", async () => {
    const decide = vi.fn().mockResolvedValue(undefined);
    const items = [item("a"), contra("c"), item("x", { operation: "delete" })];
    const act = inboxKeyAction("Enter", true);
    if (act.type !== "approve") throw new Error("esperava approve");
    const out = await approveBulk(items, decide, { acknowledgeContradictions: act.acknowledge });
    expect(decide.mock.calls.map((c) => c[0])).toEqual(["e-a"]);
    expect(out.skippedContradictions).toEqual(["c"]);
    expect(out.skippedDeletions).toEqual(["x"]);
  });
  it("Esc fecha ou cancela a confirmacao", () => {
    expect(inboxKeyAction("Escape", false).type).toBe("close");
    expect(inboxKeyAction("Escape", true).type).toBe("cancel-confirm");
  });
  it("prioridade alta pedida por agente e sinalizada; a do usuario nao", () => {
    expect(asksHighPriority(item("a", { priority: 3 }))).toBe(true);
    expect(asksHighPriority(item("a", { priority: 2 }))).toBe(false);
    expect(asksHighPriority(item("a", { priority: 9, evidence: { runId: null, taskId: null, factId: null, actorKind: "user", reason: null } }))).toBe(false);
  });
});
