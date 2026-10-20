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

  it("a moldura tem a mesma espessura na tela qualquer que seja a escala da página", () => {
    const half = phoneScreen(0.5).boxShadow as string;
    const full = phoneScreen(1).boxShadow as string;
    expect(half.startsWith("0 0 0 22px")).toBe(true);
    expect(full.startsWith("0 0 0 11px")).toBe(true);
    expect(phoneScreen(1).overflow).toBe("hidden");
  });
});
