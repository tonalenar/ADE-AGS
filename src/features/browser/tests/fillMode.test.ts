import { describe, expect, it } from "vitest";

import { FILL_VIEWPORT, fillLayout, isFillViewport } from "../viewport";

describe("1920×1080: a página preenche a janela", () => {
  it("só 1920×1080 liga o modo; qualquer outra resolução continua no quadro", () => {
    expect(isFillViewport({ width: 1920, height: 1080 })).toBe(true);
    expect(isFillViewport({ width: 1440, height: 900 })).toBe(false);
    expect(isFillViewport({ width: 1920, height: 1000 })).toBe(false);
    expect(isFillViewport(null)).toBe(false);
    expect(FILL_VIEWPORT).toEqual({ width: 1920, height: 1080 });
  });

  it("numa janela de 1000×560 a página é um layout de 1920 px reduzido, e a altura é a que sobrar (sem margem)", () => {
    const layout = fillLayout(FILL_VIEWPORT, { width: 1000, height: 560 });
    expect(layout.scale).toBeCloseTo(1000 / 1920, 5);
    expect(layout.width! * layout.scale).toBeCloseTo(1000, 5); // ocupa a largura toda
    expect(layout.height! * layout.scale).toBeCloseTo(560, 5); // e a altura toda
    expect(layout.width).toBeCloseTo(1920, 3);
  });

  it("numa janela maior que 1920 a página não é ampliada: o layout cresce para preencher", () => {
    const layout = fillLayout(FILL_VIEWPORT, { width: 2400, height: 1200 });
    expect(layout.scale).toBe(1);
    expect(layout.width).toBe(2400);
    expect(layout.height).toBe(1200);
  });

  it("o zoom da página multiplica a escala e o layout acompanha, sempre preenchendo", () => {
    const layout = fillLayout(FILL_VIEWPORT, { width: 960, height: 540 }, 2);
    expect(layout.scale).toBeCloseTo(1, 5);
    expect(layout.width! * layout.scale).toBeCloseTo(960, 5);
  });

  it("antes de medir a janela, não inventa tamanho", () => {
    expect(fillLayout(FILL_VIEWPORT, { width: 0, height: 0 })).toEqual({ scale: 1, width: null, height: null });
  });
});
