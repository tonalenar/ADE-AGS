import { describe, expect, it } from "vitest";

import { fillLayout, fitScale } from "../viewport";

const FULL_HD = { width: 1920, height: 1080 };

describe("fillLayout", () => {
  it("nó mais largo que 16:9: a página ocupa a largura inteira e encolhe a altura (antes sobrava faixa nas laterais)", () => {
    // O bug: 1920×1080 num espaço de 1344×636 era reduzido pela ALTURA (0,58) e a página ficava com 1113 px de 1344.
    const available = { width: 1344, height: 636 };
    expect(fitScale(FULL_HD, available) * FULL_HD.width).toBeLessThan(available.width * 0.85);

    const layout = fillLayout(FULL_HD, available);
    expect(layout.width).toBe(1920);
    expect(layout.scale).toBe(0.7);
    expect(Math.round(layout.width * layout.scale)).toBeGreaterThanOrEqual(available.width - 2);
    expect(Math.round(layout.height * layout.scale)).toBeLessThanOrEqual(available.height);
    expect(Math.round(layout.height * layout.scale)).toBeGreaterThanOrEqual(available.height - 2);
  });

  it("nó mais alto que 16:9: a escala já é a da largura e a altura cresce até o fim do nó", () => {
    const available = { width: 960, height: 900 };
    const layout = fillLayout(FULL_HD, available);
    expect(layout.scale).toBe(0.5);
    expect(layout.width).toBe(1920);
    expect(layout.height).toBe(1800);
  });

  it("nó que cabe o quadro inteiro: nada muda", () => {
    expect(fillLayout(FULL_HD, { width: 2400, height: 1400 })).toEqual({ scale: 1, width: 1920, height: 1080 });
  });

  it("telefone e tablet seguem exatos: o tamanho pedido é o que se testa", () => {
    const phone = { width: 390, height: 844 };
    expect(fillLayout(phone, { width: 1200, height: 900 })).toEqual({ scale: 1, width: 390, height: 844 });
    const tablet = { width: 768, height: 1024 };
    const layout = fillLayout(tablet, { width: 600, height: 500 });
    expect(layout).toEqual({ scale: fitScale(tablet, { width: 600, height: 500 }), ...tablet });
  });

  it("sem medida ainda (0×0): devolve o quadro como foi pedido", () => {
    expect(fillLayout(FULL_HD, { width: 0, height: 0 })).toEqual({ scale: 1, ...FULL_HD });
  });

  it("nunca deixa a altura abaixo do mínimo", () => {
    expect(fillLayout(FULL_HD, { width: 1000, height: 40 }).height).toBeGreaterThanOrEqual(240);
  });
});
