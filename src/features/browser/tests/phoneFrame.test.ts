import { describe, expect, it } from "vitest";

import { phoneScreen } from "../ResponsiveStage";
import { isPhoneViewport } from "../viewport";

/** No tamanho de celular, o navegador vira um aparelho, como num mockup. */
describe("navegador com cara de celular", () => {
  it("só os tamanhos de celular (em pé ou deitado) viram aparelho", () => {
    expect(isPhoneViewport({ width: 430, height: 932 })).toBe(true);
    expect(isPhoneViewport({ width: 932, height: 430 })).toBe(true);
    expect(isPhoneViewport({ width: 768, height: 1024 })).toBe(false);
    expect(isPhoneViewport(null)).toBe(false);
  });

  it("a moldura é proporcional ao aparelho: encolhe junto com a escala, até o mínimo legível", () => {
    const monitorBezel = (scale: number) => parseFloat((phoneScreen(scale).boxShadow as string).split(" ")[3]) * scale;
    expect(monitorBezel(1)).toBeCloseTo(10, 5);
    expect(monitorBezel(0.5)).toBeCloseTo(5, 5);
    expect(monitorBezel(0.2)).toBeCloseTo(4, 5);
    expect(phoneScreen(1).overflow).toBe("hidden");
  });

  it("as cores da moldura vêm dos tokens do tema, sem hex", () => {
    const shadow = phoneScreen(1).boxShadow as string;
    expect(shadow).toContain("var(--color-device-bezel)");
    expect(shadow).toContain("var(--color-device-rim)");
    expect(shadow).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
