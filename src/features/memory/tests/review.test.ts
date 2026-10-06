import { describe, expect, it, vi } from "vitest";

import { decideAll, evidenceParts, reviewFlag, sortReviewItems } from "../review";
import type { MemoryReviewItem } from "../types";

const item = (over: Partial<MemoryReviewItem>): MemoryReviewItem => ({
  entryId: "e", revision: 1, key: "k", kind: "note", body: "b", priority: 0,
  evidence: { runId: null, taskId: null, factId: null, actorKind: "worker", reason: null },
  duplicateOf: null, contradicts: null, highValue: false, score: 10, ...over,
});

describe("reviewFlag", () => {
  it("contradição vence duplicata, que vence valor", () => {
    const ref = { entryId: "x", key: "x" };
    expect(reviewFlag(item({ contradicts: ref, duplicateOf: ref, highValue: true }))).toBe("contradiction");
    expect(reviewFlag(item({ duplicateOf: ref, highValue: true }))).toBe("duplicate");
    expect(reviewFlag(item({ highValue: true }))).toBe("highValue");
    expect(reviewFlag(item({ score: 70 }))).toBe("highValue");
    expect(reviewFlag(item({ score: 69 }))).toBe("normal");
  });
});

describe("sortReviewItems", () => {
  it("contradições, valor alto, normais e duplicatas por último; não muta a entrada", () => {
    const ref = { entryId: "x", key: "x" };
    const input = [
      item({ key: "dup", duplicateOf: ref, score: 90 }),
      item({ key: "norm", score: 20 }),
      item({ key: "hi", score: 80, highValue: true }),
      item({ key: "con", contradicts: ref, score: 5 }),
    ];
    expect(sortReviewItems(input).map((i) => i.key)).toEqual(["con", "hi", "norm", "dup"]);
    expect(input[0].key).toBe("dup");
  });
});

describe("decideAll", () => {
  it("decide cada item e segue após falha", async () => {
    const decide = vi.fn(async (id: string) => { if (id === "b") throw new Error("x"); });
    const r = await decideAll([item({ entryId: "a", key: "A" }), item({ entryId: "b", key: "B" }), item({ entryId: "c", key: "C", revision: 3 })], true, decide);
    expect(r).toEqual({ done: 2, failed: ["B"] });
    expect(decide).toHaveBeenCalledWith("c", 3, true);
    expect(decide).toHaveBeenCalledTimes(3);
  });

  it("lista vazia não chama nada", async () => {
    const decide = vi.fn();
    expect(await decideAll([], false, decide)).toEqual({ done: 0, failed: [] });
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("evidenceParts", () => {
  it("só inclui o que existe", () => {
    expect(evidenceParts(item({}))).toEqual({});
    expect(evidenceParts(item({ evidence: { runId: "r", taskId: null, factId: "f", actorKind: "lead", reason: "porque" } })))
      .toEqual({ runId: "r", factId: "f", reason: "porque" });
  });
});
