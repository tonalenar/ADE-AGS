import { describe, expect, it } from "vitest";

import { FRAME_WIDTHS, focusFrame } from "../focusGeometry";

describe("largura da prancheta no modo focado", () => {
  it("as larguras são desktop 1280, tablet 834 e celular 390", () => {
    expect(FRAME_WIDTHS).toEqual({ desktop: 1280, tablet: 834, mobile: 390 });
  });

  it("sem largura escolhida, Preencher ocupa a janela e Caber reduz a prancheta original", () => {
    const fill = focusFrame({ board: { w: 1440, h: 900 }, fit: "fill", width: null, box: { w: 1000, h: 700 } });
    expect(fill).toMatchObject({ w: 1000, h: 700, k: 1, left: 0, top: 0 });
    const fit = focusFrame({ board: { w: 1440, h: 900 }, fit: "fit", width: null, box: { w: 1200, h: 800 } });
    expect(fit.k).toBeCloseTo(Math.min((1200 - 48) / 1440, (800 - 48) / 900), 5);
    expect(fit.w).toBe(1440);
  });

  it("celular 390 em Caber: a prancheta tem 390 px de largura reduzida para caber, centrada", () => {
    const g = focusFrame({ board: { w: 1440, h: 900 }, fit: "fit", width: 390, box: { w: 1200, h: 800 } });
    expect(g.w).toBe(390);
    expect(g.k).toBeCloseTo((800 - 48) / 900, 5);
    expect(g.left).toBeCloseTo((1200 - 390 * g.k) / 2, 5);
  });

  it("desktop 1280 em Preencher: escala a largura para caber na janela e ocupa a altura toda", () => {
    const g = focusFrame({ board: { w: 390, h: 844 }, fit: "fill", width: 1280, box: { w: 1000, h: 700 } });
    expect(g.k).toBeCloseTo(1000 / 1280, 5);
    expect(g.h).toBe(700);
    expect(g.left).toBeCloseTo(0, 5);
  });

  it("sem medida da janela ainda, não escala", () => {
    expect(focusFrame({ board: { w: 390, h: 844 }, fit: "fit", width: 834, box: { w: 0, h: 0 } }).k).toBe(1);
  });
});
