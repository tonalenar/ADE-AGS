import { describe, expect, it } from "vitest";

import { PHONE_MODELS } from "../deviceCatalog";
import { buttonRects, miniScale, monitorFrame } from "../phoneGeometry";

const pro = PHONE_MODELS.find((m) => m.id === "iphone-17-pro")!;
const pixel = PHONE_MODELS.find((m) => m.id === "pixel-9")!;

describe("geometria da moldura no palco", () => {
  it("a moldura escala com o aparelho, com um mínimo legível na miniatura", () => {
    expect(monitorFrame(pro, 1)).toEqual({ bezel: 10, rim: 2 });
    expect(monitorFrame(pro, 0.7).bezel).toBeCloseTo(7, 5);
    expect(monitorFrame(pro, 0.2).bezel).toBe(4);
    expect(monitorFrame(pro, 0.2).rim).toBe(1.5);
  });

  it("a miniatura encaixa o aparelho INTEIRO (com a moldura) na caixa, em pé e deitado", () => {
    const box = { width: 300, height: 600 };
    const s = miniScale({ width: 402, height: 874 }, box, pro, 6);
    expect((402 + 24) * s).toBeLessThanOrEqual(294.0001);
    expect((874 + 24) * s).toBeLessThanOrEqual(594.0001);
    const land = miniScale({ width: 874, height: 402 }, { width: 600, height: 300 }, pro, 6);
    expect(land).toBeCloseTo(s, 5);
  });

  it("iPhone deitado: ação e volumes saem pela borda de baixo e o liga/desliga pela de cima", () => {
    const w = 874, h = 402;
    const rects = buttonRects(pro, true, w, h, 1);
    const kinds = (pred: (r: { top: number }) => boolean) => rects.filter(pred).map((r) => r.kind);
    expect(kinds((r) => r.top > h)).toEqual(["action", "volUp", "volDown"]);
    expect(kinds((r) => r.top < 0)).toEqual(["power"]);
    for (const r of rects) expect(r.left).toBeGreaterThanOrEqual(0);
  });

  it("Pixel em pé: todos os botões na borda direita, fora da tela", () => {
    const rects = buttonRects(pixel, false, 412, 924, 1);
    expect(rects).toHaveLength(2);
    for (const r of rects) expect(r.left).toBeGreaterThan(412);
  });

  it("a espessura do botão escala com o aparelho, com o mínimo de 2 px", () => {
    expect(buttonRects(pro, false, 402, 874, 1)[0].width).toBe(3);
    expect(buttonRects(pro, false, 201, 437, 0.5)[0].width).toBe(2);
    const half = buttonRects(pro, false, 201, 437, 0.5)[0];
    const full = buttonRects(pro, false, 402, 874, 1)[0];
    expect(half.height).toBeCloseTo(full.height / 2, 5);
  });
});
