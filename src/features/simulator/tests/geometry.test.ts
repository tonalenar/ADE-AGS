import { describe, expect, it } from "vitest";

import {
  clampScale, isLandscape, minScale, nodeSize, orientedScreen, phoneOf, scaleOf, SIM_BAR_H, SIM_CHAT_W, SIM_GAP_X, SIM_GAP_Y, SIM_MIN_W, stepScale,
} from "../geometry";

const proMax = { width: 440, height: 956, family: "iphone" as const };
const ipad = { width: 834, height: 1210, family: "ipad" as const };

describe("bloco do simulador solto", () => {
  it("a barra tem a largura do aparelho e a altura soma barra, espaço e aparelho", () => {
    const phone = phoneOf(proMax, 0.64);
    const size = nodeSize(proMax, 0.64, false);
    expect(size.w).toBe(Math.round(phone.w));
    expect(size.h).toBe(Math.round(SIM_BAR_H + SIM_GAP_Y + phone.h));
  });

  it("com a conversa aberta o bloco cresce só para a direita, do tamanho do painel", () => {
    const closed = nodeSize(proMax, 0.64, false);
    const open = nodeSize(proMax, 0.64, true);
    expect(open.h).toBe(closed.h);
    expect(open.w - closed.w).toBe(SIM_GAP_X + SIM_CHAT_W);
  });

  it("a escala sai da altura gravada e volta igual", () => {
    for (const scale of [0.5, 0.64, 0.9, 1.1]) {
      expect(scaleOf(proMax, nodeSize(proMax, scale, false).h)).toBeCloseTo(scale, 2);
    }
  });

  it("o aparelho nunca fica mais estreito que a barra compacta", () => {
    expect(phoneOf(proMax, minScale(proMax)).w).toBeCloseTo(SIM_MIN_W, 5);
    expect(clampScale(proMax, 0.1)).toBeCloseTo(minScale(proMax), 3);
    expect(clampScale(proMax, 5)).toBe(1.2);
    expect(stepScale(proMax, 1.2, 1)).toBe(1.2);
  });

  it("o iPad tem cantos quase retos e o iPhone bem redondos", () => {
    const iphone = phoneOf(proMax, 1);
    const tablet = phoneOf(ipad, 1);
    expect(iphone.screenRadius / iphone.screenW).toBeGreaterThan(tablet.screenRadius / tablet.screenW * 2);
    expect(iphone.outerRadius).toBeCloseTo(iphone.screenRadius + iphone.bezel, 5);
  });
});

describe("giro do aparelho", () => {
  it("em paisagem a tela troca largura e altura; em retrato fica como é", () => {
    expect(orientedScreen(proMax, true)).toEqual({ width: 956, height: 440, family: "iphone" });
    expect(orientedScreen(proMax, false)).toBe(proMax);
  });

  it("só as duas paisagens deitam a moldura", () => {
    expect(isLandscape("landscapeLeft")).toBe(true);
    expect(isLandscape("landscapeRight")).toBe(true);
    expect(isLandscape("portrait")).toBe(false);
    expect(isLandscape("portraitUpsideDown")).toBe(false);
  });

  it("deitar mantém a escala: o box deitado, relido, devolve a mesma escala", () => {
    const deitada = orientedScreen(proMax, true);
    const box = nodeSize(deitada, 0.64, false);
    expect(scaleOf(deitada, box.h)).toBeCloseTo(0.64, 2);
  });
});
