import { describe, expect, it } from "vitest";

import { BOARD_GAP, spreadOverlapping } from "../layout";

const board = (id: string, x: number, y: number, width = 400, height = 300) => ({ id, x, y, width, height });

describe("spreadOverlapping", () => {
  it("separa pranchetas empilhadas em (0, 0), lado a lado e na ordem", () => {
    const out = spreadOverlapping([board("a", 0, 0), board("b", 0, 0, 200), board("c", 0, 0)]);
    expect(out.map((b) => [b.id, b.x, b.y])).toEqual([["a", 0, 0], ["b", 400 + BOARD_GAP, 0], ["c", 400 + BOARD_GAP + 200 + BOARD_GAP, 0]]);
  });

  it("mantém posições que não se sobrepõem (o usuário pode ter arrumado à mão)", () => {
    const boards = [board("a", 0, 0), board("b", 500, 0), board("c", 0, 400)];
    expect(spreadOverlapping(boards)).toBe(boards);
  });

  it("não altera as originais e aceita lista vazia ou uma só", () => {
    const stacked = [board("a", 0, 0), board("b", 10, 10)];
    spreadOverlapping(stacked);
    expect(stacked[1].x).toBe(10);
    expect(spreadOverlapping([])).toEqual([]);
    const one = [board("a", 0, 0)];
    expect(spreadOverlapping(one)).toBe(one);
  });
});
