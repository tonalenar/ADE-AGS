import { describe, expect, it } from "vitest";

import { chromeInsets, shownAddress } from "../PhoneChrome";

describe("PhoneChrome", () => {
  it("mostra o domínio sem protocolo nem www", () => {
    expect(shownAddress("https://www.github.com/login?x=1")).toBe("github.com");
    expect(shownAddress("http://localhost:3000/app")).toBe("localhost");
    expect(shownAddress("")).toBe("");
  });

  it("a página começa abaixo da barra de status e, no iPhone, vai até o fim da tela (o vidro fica dentro dela)", () => {
    expect(chromeInsets("ios", false)).toEqual({ top: 54, bottom: 0, left: 0, right: 0 });
    expect(chromeInsets("android", false)).toEqual({ top: 92, bottom: 30, left: 0, right: 0 });
    expect(chromeInsets("ios", true)).toEqual({ top: 0, bottom: 0, left: 47, right: 47 });
  });
});
