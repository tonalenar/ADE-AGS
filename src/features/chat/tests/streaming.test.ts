import { describe, expect, it } from "vitest";

import {
  appendDelta, createFrameBatcher, FRESH_SLACK_MS, isFresh, REVEAL_BASE_CPS, REVEAL_MAX_MS, revealAdvance, revealCut, revealDone, revealStart,
  revealTarget, withDrafts, type Reveal,
} from "@/features/chat/timeline/streaming";
import type { TimelineItem } from "@/features/chat/timeline/types";

/** Avança o revelar em quadros de 16 ms até acabar; devolve quantos ms levou. */
function runUntilDone(r: Reveal): number {
  let ms = 0;
  while (!revealDone(r) && ms < 60_000) {
    r = revealAdvance(r, 16);
    ms += 16;
  }
  return ms;
}

describe("texto chegando: rascunhos", () => {
  it("os pedaços crescem no mesmo item e um item novo vai para o fim; vazio não conta", () => {
    let drafts = appendDelta([], { itemId: "a", delta: "Oi" });
    drafts = appendDelta(drafts, { itemId: "b", delta: "hm", kind: "reasoning" });
    drafts = appendDelta(drafts, { itemId: "a", delta: ", tudo" });
    expect(appendDelta(drafts, { itemId: "a", delta: "" })).toBe(drafts);
    expect(drafts).toEqual([{ itemId: "a", kind: "assistant", text: "Oi, tudo" }, { itemId: "b", kind: "reasoning", text: "hm" }]);
  });

  it("o rascunho entra na timeline como item com o id do item final, até o item chegar", () => {
    const items: TimelineItem[] = [{ kind: "user", id: "u", text: "oi" }];
    expect(withDrafts(items, [])).toBe(items);
    const merged = withDrafts(items, [{ itemId: "m", kind: "assistant", text: "Ol" }, { itemId: "r", kind: "reasoning", text: "pensando" }]);
    expect(merged.map((i) => [i.kind, i.id, i.text])).toEqual([["user", "u", "oi"], ["assistant", "m", "Ol"], ["reasoning", "r", "pensando"]]);
    const arrived = [...items, { kind: "assistant" as const, id: "m", text: "Olá" }];
    expect(withDrafts(arrived, [{ itemId: "m", kind: "assistant", text: "Ol" }])).toBe(arrived);
  });

  it("o lote junta o que chega num quadro e entrega uma vez; entregar já cancela o quadro", () => {
    const scheduled: Array<() => void> = [];
    let cancelled = 0;
    const batches: number[][] = [];
    const batcher = createFrameBatcher<number>((run) => { scheduled.push(run); return () => { cancelled++; }; }, (b) => batches.push(b));
    batcher.push(1);
    batcher.push(2);
    batcher.push(3);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(batches).toEqual([[1, 2, 3]]);
    batcher.push(4);
    batcher.flushNow();
    expect(cancelled).toBe(1);
    expect(batches).toEqual([[1, 2, 3], [4]]);
    batcher.flushNow();
    expect(batches).toHaveLength(2);
    expect(batcher.size).toBe(0);
  });
});

describe("texto chegando: o ritmo do revelar", () => {
  it("texto curto vai na velocidade natural", () => {
    const text = "Pronto, rodei os testes.";
    const ms = runUntilDone(revealStart(text.length));
    expect(ms).toBeGreaterThanOrEqual(Math.floor((text.length / REVEAL_BASE_CPS) * 1000) - 16);
    expect(ms).toBeLessThan(REVEAL_MAX_MS);
  });

  it("texto longo acelera e nunca passa do teto", () => {
    expect(runUntilDone(revealStart(20_000))).toBeLessThanOrEqual(REVEAL_MAX_MS + 16);
    expect(revealStart(20_000).rate).toBeGreaterThan(revealStart(100).rate);
  });

  it("chegou mais texto: recalcula pelo que falta, sem voltar o que já apareceu", () => {
    let r = revealAdvance(revealStart(100), 200);
    const shown = r.shown;
    r = revealTarget(r, 5_000);
    expect(r.shown).toBe(shown);
    expect(runUntilDone(r)).toBeLessThanOrEqual(REVEAL_MAX_MS + 16);
    // O item final mais curto que o rascunho só corta.
    expect(revealTarget({ shown: 80, rate: 1, target: 100 }, 50)).toEqual({ shown: 50, rate: 1, target: 50 });
    const same = revealStart(10);
    expect(revealTarget(same, 10)).toBe(same);
  });

  it("corta no fim da palavra, nunca no meio", () => {
    const text = "Rodei os testes agora";
    expect(revealCut(text, 0)).toBe(0);
    expect(text.slice(0, revealCut(text, 2))).toBe("Rodei");
    expect(text.slice(0, revealCut(text, 6))).toBe("Rodei ");
    expect(text.slice(0, revealCut(text, 17))).toBe("Rodei os testes agora");
    expect(revealCut(text, 999)).toBe(text.length);
  });
});

describe("texto chegando: o que aparece aos poucos", () => {
  const mountedAt = 1_000_000;
  it("só a fala do agente que chegou depois de abrir; o histórico aparece inteiro", () => {
    const baseline = new Set(["velha"]);
    expect(isFresh({ kind: "assistant", id: "nova", at: mountedAt + 5 }, baseline, mountedAt)).toBe(true);
    expect(isFresh({ kind: "assistant", id: "velha", at: mountedAt + 5 }, baseline, mountedAt)).toBe(false);
    expect(isFresh({ kind: "assistant", id: "antiga", at: mountedAt - FRESH_SLACK_MS - 1 }, baseline, mountedAt)).toBe(false);
    expect(isFresh({ kind: "assistant", id: "sem-carimbo" }, baseline, mountedAt)).toBe(false);
    expect(isFresh({ kind: "user", id: "eu", at: mountedAt + 5 }, baseline, mountedAt)).toBe(false);
  });
});
