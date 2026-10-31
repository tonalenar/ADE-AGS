import { describe, expect, it } from "vitest";

import { marqueeHits, nextBoardSlot, normalizeRect, resizeFromCorner, snapMove, unstack } from "../snap";

describe("snap e redimensionar", () => {
  const other = { x: 500, y: 0, w: 200, h: 200 };

  it("encosta a borda a menos de 8 px de tela, medidos na escala", () => {
    const r = snapMove({ x: 295, y: 3, w: 200, h: 100 }, [other], 1);
    expect(r.x).toBe(300); // direita (495) encosta em 500
    expect(r.y).toBe(0);
    expect(r.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
    // em 50% o limiar vale 16 px de mundo
    expect(snapMove({ x: 285, y: 50, w: 200, h: 100 }, [other], 0.5).x).toBe(300);
    expect(snapMove({ x: 285, y: 50, w: 200, h: 100 }, [other], 1).x).toBe(285);
    expect(snapMove({ x: 295, y: 3, w: 200, h: 100 }, [other], 1, false)).toEqual({ x: 295, y: 3, guides: [] });
  });

  it("canto oposto parado, mínimo 120 e máximo 8000", () => {
    const start = { x: 0, y: 0, w: 400, h: 300 };
    expect(resizeFromCorner(start, "se", 100, 50, { snap: false })).toMatchObject({ x: 0, y: 0, w: 500, h: 350 });
    expect(resizeFromCorner(start, "nw", 100, 50, { snap: false })).toMatchObject({ x: 100, y: 50, w: 300, h: 250 });
    expect(resizeFromCorner(start, "nw", 1000, 1000, { snap: false })).toMatchObject({ x: 280, y: 180, w: 120, h: 120 });
    expect(resizeFromCorner(start, "se", 20000, 0, { snap: false }).w).toBe(8000);
  });

  it("Shift mantém a proporção; a borda que se move encosta nas outras", () => {
    const r = resizeFromCorner({ x: 0, y: 0, w: 400, h: 200 }, "se", 200, 10, { keepAspect: true, snap: false });
    expect(r.w / r.h).toBeCloseTo(2);
    const s = resizeFromCorner({ x: 0, y: 0, w: 400, h: 200 }, "se", 96, 0, { others: [other], scale: 1 });
    expect(s.w).toBe(500);
  });

  it("marquee, retângulo normalizado e o próximo lugar livre", () => {
    expect(normalizeRect(10, 10, 0, 5)).toEqual({ x: 0, y: 5, w: 10, h: 5 });
    expect(marqueeHits({ x: 0, y: 0, w: 510, h: 10 }, [{ id: "o", ...other }, { id: "n", x: 900, y: 0, w: 10, h: 10 }])).toEqual(["o"]);
    expect(nextBoardSlot([])).toEqual({ x: 0, y: 0 });
    expect(nextBoardSlot([{ x: 0, y: 40, w: 100, h: 10 }, other])).toEqual({ x: 780, y: 0 });
  });

  it("desempilha só as que repetem o ponto de uma anterior", () => {
    const boards = [{ id: "a", x: 0, y: 0, w: 100, h: 100 }, { id: "b", x: 0, y: 0, w: 100, h: 100 }, { id: "c", x: 50, y: 50, w: 10, h: 10 }];
    const out = unstack(boards);
    expect(out.moved).toEqual(["b"]);
    expect(out.boards[1]).toMatchObject({ x: 180, y: 0 });
    expect(out.boards[2]).toMatchObject({ x: 50, y: 50 });
    const clean = [{ id: "a", x: 0, y: 0, w: 1, h: 1 }];
    expect(unstack(clean).boards).toBe(clean);
  });
});
