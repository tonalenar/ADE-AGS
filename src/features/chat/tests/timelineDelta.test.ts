import { describe, expect, it } from "vitest";

import { applyTimelineDelta, type TimelineDelta } from "../timeline/delta";
import type { Timeline, TimelineItem } from "../timeline/types";

const user = (n: number): TimelineItem => ({ kind: "user", id: `u${n}`, text: `pergunta ${n}` });
const tool = (status: "running" | "done"): TimelineItem => ({ kind: "tool", id: "t1", name: "Bash", status });
const delta = (from: number, items: TimelineItem[], total = from + items.length, rev = 2): TimelineDelta => ({ rev, truncated: false, total, from, items });

describe("applyTimelineDelta", () => {
  it("sem mudança devolve o mesmo objeto, sem rebaixar a timeline", () => {
    const prev: Timeline = { items: [user(1), user(2)], truncated: false };
    expect(applyTimelineDelta(prev, delta(2, []))).toBe(prev);
  });

  it("itens novos entram no fim e os antigos mantêm a identidade", () => {
    const prev: Timeline = { items: [user(1), user(2)], truncated: false };
    const next = applyTimelineDelta(prev, delta(2, [user(3)]))!;
    expect(next).not.toBe(prev);
    expect(next.items).toHaveLength(3);
    expect(next.items[0]).toBe(prev.items[0]);
    expect(next.items[1]).toBe(prev.items[1]);
  });

  it("um item reenviado igual mantém o objeto; um alterado é trocado", () => {
    const prev: Timeline = { items: [user(1), tool("running"), user(2)], truncated: false };
    const igual = applyTimelineDelta(prev, delta(1, [{ ...tool("running") }, { ...user(2) }]));
    expect(igual).toBe(prev);
    const mudou = applyTimelineDelta(prev, delta(1, [tool("done"), { ...user(2) }, user(3)]))!;
    expect(mudou.items[0]).toBe(prev.items[0]);
    expect(mudou.items[1].status).toBe("done");
    expect(mudou.items[2]).toBe(prev.items[2]);
    expect(mudou.items).toHaveLength(4);
  });

  it("cauda que não encaixa pede a timeline inteira", () => {
    const prev: Timeline = { items: [user(1)], truncated: false };
    expect(applyTimelineDelta(prev, delta(5, [user(6)]))).toBeNull();
    expect(applyTimelineDelta(prev, delta(1, [user(2)], 9))).toBeNull();
  });

  it("sem timeline anterior, a resposta completa (from 0) vira a timeline", () => {
    const next = applyTimelineDelta(null, delta(0, [user(1)]))!;
    expect(next.items).toEqual([user(1)]);
  });
});
