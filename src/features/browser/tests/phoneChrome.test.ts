import { describe, expect, it } from "vitest";

import { chromeInsets, shownAddress } from "../PhoneChrome";

describe("mockup do aparelho", () => {
  it("o iPhone reserva a barra de status em cima e o Safari embaixo; o Android, o Chrome em cima", () => {
    expect(chromeInsets("ios", false)).toEqual({ top: 54, bottom: 114, left: 0, right: 0 });
    expect(chromeInsets("android", false)).toEqual({ top: 92, bottom: 30, left: 0, right: 0 });
  });

  it("deitado, a ilha/câmera vira uma faixa lateral", () => {
    expect(chromeInsets("ios", true).left).toBeGreaterThan(0);
    expect(chromeInsets("android", true).left).toBeGreaterThan(0);
  });

  it("o endereço aparece como no navegador do aparelho", () => {
    expect(shownAddress("https://www.github.com/login?x=1")).toBe("github.com");
    expect(shownAddress("http://localhost:3000/app")).toBe("localhost");
    expect(shownAddress("")).toBe("");
  });
});
