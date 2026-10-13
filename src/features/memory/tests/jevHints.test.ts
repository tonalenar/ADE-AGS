import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { allHinted, fetchHints, hintTone, jevApprovedIds, type JevHint } from "../jevHints";
import type { MemoryReviewItem } from "../types";

const item = (n: number): MemoryReviewItem => ({ entryId: `e${n}`, revision: 1, key: `k${n}`, kind: "note", body: `corpo ${n}`, operation: "create" } as unknown as MemoryReviewItem);
const hint = (index: number, action: JevHint["action"], extra: Partial<JevHint> = {}): JevHint => ({ index, provider: "jev", action, secret: false, confidence: 0.95, ...extra });

describe("dicas do Jev na revisão de memória", () => {
  it("manda as propostas ao backend e liga cada dica à sua proposta pelo índice", async () => {
    invoke.mockResolvedValueOnce([hint(1, "rejeitar")]);
    const found = await fetchHints([item(0), item(1)]);
    expect(invoke).toHaveBeenCalledWith("decision_memory_hints", { items: [
      { key: "k0", kind: "note", operation: "create", body: "corpo 0" },
      { key: "k1", kind: "note", operation: "create", body: "corpo 1" },
    ] });
    expect(Object.keys(found)).toEqual(["e1:1"]);
    expect(found["e1:1"].action).toBe("rejeitar");
  });

  it("sem propostas não consulta nada", async () => {
    invoke.mockClear();
    expect(await fetchHints([])).toEqual({});
    expect(invoke).not.toHaveBeenCalled();
  });

  it("só marca o que o Jev aprovaria: sem suspeita de segredo e com confiança alta", () => {
    const items = [0, 1, 2, 3, 4, 5].map(item);
    const hints: Record<string, JevHint> = {
      "e0:1": hint(0, "aprovar"),
      "e1:1": hint(1, "aprovar", { secret: true }),
      "e2:1": hint(2, "aprovar", { confidence: 0.6 }),
      "e3:1": hint(3, "revisar"),
      "e4:1": hint(4, "rejeitar"),
      "e5:1": hint(5, "aprovar", { confidence: null }),
    };
    expect(jevApprovedIds(items, hints)).toEqual(["e0:1", "e5:1"]);
  });

  it("sabe quando todas as propostas já têm dica e qual é o tom de cada uma", () => {
    const items = [item(0), item(1)];
    expect(allHinted(items, { "e0:1": hint(0, "aprovar") })).toBe(false);
    expect(allHinted(items, { "e0:1": hint(0, "aprovar"), "e1:1": hint(1, "revisar") })).toBe(true);
    expect([hint(0, "aprovar"), hint(0, "rejeitar"), hint(0, "revisar")].map(hintTone)).toEqual(["approve", "reject", "review"]);
  });
});
