import { describe, expect, it } from "vitest";

import { timelineTurns, timelineTurnsCached } from "@/features/chat/timeline/timelineModel";
import type { TimelineItem } from "@/features/chat/timeline/types";

const user = (id: string, text = "faça"): TimelineItem => ({ kind: "user", id, text, at: 1000 });
const say = (id: string, text: string): TimelineItem => ({ kind: "assistant", id, text });
const tool = (id: string): TimelineItem => ({ kind: "tool", id, tool: "read", label: `${id}.ts`, status: "done" });
const end = (id: string): TimelineItem => ({ kind: "turnEnd", id, durationMs: 4000 });

describe("a conta dos turnos reaproveita o que já fechou", () => {
  it("turnos_fechados_mantem_identidade: um pedaço novo no fim não refaz os turnos anteriores", () => {
    const items = [user("u1"), say("a1", "primeira"), end("e1"), user("u2"), say("a2", "segunda")];
    const first = timelineTurnsCached(null, items);
    const streamed = [...items.slice(0, 4), say("a2", "segunda, com mais texto")];
    const second = timelineTurnsCached(first, streamed);
    expect(second.turns[0]).toBe(first.turns[0]);
    expect(second.turns[1]).not.toBe(first.turns[1]);
    expect(second.turns).toEqual(timelineTurns(streamed));
  });

  it("o resultado é o mesmo do cálculo completo em outros cenários (ferramenta, aviso, pergunta nova no meio)", () => {
    const steps: TimelineItem[][] = [
      [user("u1"), tool("t1")],
      [user("u1"), tool("t1"), tool("t2")],
      [user("u1"), tool("t1"), tool("t2"), end("e1")],
      [user("u1"), tool("t1"), tool("t2"), end("e1"), user("u2")],
      [user("u1"), tool("t1"), tool("t2"), end("e1"), user("u2"), { kind: "notice", id: "n1", text: "aviso" } as TimelineItem, say("a2", "resposta")],
    ];
    let cache = null as ReturnType<typeof timelineTurnsCached> | null;
    for (const items of steps) {
      cache = timelineTurnsCached(cache, items);
      expect(cache.turns).toEqual(timelineTurns(items));
    }
  });
});
