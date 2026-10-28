import { describe, expect, it } from "vitest";

import { ageOf, canMove, countsToMap, firstLine, sameCounts } from "../model";
import type { PeerMessage } from "../types";

function msg(id: number, state: PeerMessage["state"]): PeerMessage {
  return {
    id, clientId: null, kind: "tell", fromTabId: "a", fromName: "Líder", toTabId: "b", toName: "QA", text: "oi",
    raw: false, reply: false, state, position: id, forceNow: false, attempts: 0, createdAt: 0, updatedAt: 0,
    deliveredAt: null, editedAt: null, note: null,
  };
}

describe("fila de mensagens: regras da lista", () => {
  it("mostra a primeira linha com conteúdo, cortada", () => {
    expect(firstLine("\n   \n  rode os testes  \nsegunda")).toBe("rode os testes");
    expect(firstLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(firstLine("")).toBe("");
  });

  it("diz a idade na unidade que se lê melhor", () => {
    expect(ageOf(45_000, 0)).toEqual({ key: "peerQueue.ageSeconds", n: 45 });
    expect(ageOf(5 * 60_000 + 10_000, 0)).toEqual({ key: "peerQueue.ageMinutes", n: 5 });
    expect(ageOf(2 * 3_600_000 + 1, 0)).toEqual({ key: "peerQueue.ageHours", n: 2 });
    expect(ageOf(0, 10_000)).toEqual({ key: "peerQueue.ageSeconds", n: 0 });
  });

  it("as contagens viram um mapa só com quem tem fila, e mapas iguais são iguais", () => {
    const map = countsToMap([{ tabId: "t1", count: 2 }, { tabId: "t2", count: 0 }]);
    expect(map).toEqual({ t1: 2 });
    expect(sameCounts(map, { t1: 2 })).toBe(true);
    expect(sameCounts(map, { t1: 3 })).toBe(false);
    expect(sameCounts(map, { t1: 2, t2: 1 })).toBe(false);
    expect(sameCounts({}, {})).toBe(true);
  });

  it("só as que esperam se movem, e só entre si", () => {
    const list = [msg(1, "delivering"), msg(2, "queued"), msg(3, "queued")];
    expect(canMove(list, 1, -1)).toBe(false); // não passa na frente da que está sendo digitada
    expect(canMove(list, 1, 1)).toBe(true);
    expect(canMove(list, 2, -1)).toBe(true);
    expect(canMove(list, 2, 1)).toBe(false); // última
    expect(canMove(list, 0, 1)).toBe(false); // a que está sendo digitada não se move
  });
});
