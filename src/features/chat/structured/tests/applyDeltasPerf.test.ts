import { describe, expect, it } from "vitest";

import { applyDeltas, applyThreadEvent, EMPTY_LIVE, type ThreadLive } from "../model";
import type { TimelineItem } from "../../timeline/types";

describe("applyDeltas: conjunto de ids mantido no ThreadLive (F-R9)", () => {
  it("reaproveita o mesmo conjunto de ids entre lotes consecutivos de deltas", () => {
    let live: ThreadLive = EMPTY_LIVE;
    for (let i = 0; i < 50; i++) {
      live = applyThreadEvent(live, {
        type: "item",
        threadId: "t1",
        item: { kind: "assistant", id: `item-${i}`, text: `Fala ${i}` },
      });
    }

    expect(live.itemIds).toBeDefined();
    expect(live.itemIds?.size).toBe(50);

    const idsBefore = live.itemIds;
    const afterDelta1 = applyDeltas(live, [{ itemId: "live-1", delta: "Olá " }]);
    const afterDelta2 = applyDeltas(afterDelta1, [{ itemId: "live-1", delta: "mundo" }]);

    expect(afterDelta1.itemIds).toBe(idsBefore);
    expect(afterDelta2.itemIds).toBe(idsBefore);
    expect(afterDelta2.drafts).toEqual([{ itemId: "live-1", kind: "assistant", text: "Olá mundo" }]);

    // Delta atrasado de item que já chegou continua ignorado.
    expect(applyDeltas(afterDelta2, [{ itemId: "item-10", delta: "atrasado" }])).toBe(afterDelta2);
  });

  it("atualiza o índice mesmo quando um ThreadLive literal substitui items diretamente", () => {
    const items: TimelineItem[] = [
      { kind: "user", id: "u-1", text: "oi" },
      { kind: "assistant", id: "a-1", text: "pronto" },
    ];
    const manual: ThreadLive = { ...EMPTY_LIVE, items };

    expect(applyDeltas(manual, [{ itemId: "a-1", delta: "eco atrasado" }])).toBe(manual);
    const next = applyDeltas(manual, [{ itemId: "a-2", delta: "novo" }]);
    expect(next.drafts).toEqual([{ itemId: "a-2", kind: "assistant", text: "novo" }]);
    expect(next.itemIds?.has("a-1")).toBe(true);
    expect(next.itemIds?.has("u-1")).toBe(true);
  });

  it("processa 2.000 itens com 500 lotes de deltas mantendo a correção", () => {
    const items: TimelineItem[] = Array.from({ length: 2000 }, (_, i) => ({
      kind: i % 2 === 0 ? "user" : "assistant",
      id: `hist-${i}`,
      text: `Mensagem ${i}`,
    }));
    let live: ThreadLive = { ...EMPTY_LIVE, items };
    for (let i = 0; i < 500; i++) {
      live = applyDeltas(live, [
        { itemId: `hist-${i}`, delta: "ignorado" },
        { itemId: "streaming-1", delta: "x" },
      ]);
    }
    expect(live.drafts).toEqual([{ itemId: "streaming-1", kind: "assistant", text: "x".repeat(500) }]);
  });
});
