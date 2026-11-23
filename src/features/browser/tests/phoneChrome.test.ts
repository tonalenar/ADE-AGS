import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import chromeSource from "../PhoneChrome.tsx?raw";
import stageSource from "../ResponsiveStage.tsx?raw";
import { chromeInsets, PhoneChrome, shownAddress } from "../PhoneChrome";

describe("PhoneChrome", () => {
  it("mostra o domínio sem protocolo nem www", () => {
    expect(shownAddress("https://www.github.com/login?x=1")).toBe("github.com");
    expect(shownAddress("http://localhost:3000/app")).toBe("localhost");
    expect(shownAddress("")).toBe("");
  });

  it("no iPhone a página ocupa a tela inteira, em pé e deitado (sem faixas laterais)", () => {
    expect(chromeInsets("ios", false)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(chromeInsets("ios", true)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("no Android o Chrome fica em cima; deitado, a faixa da câmera tem a largura da área segura do Pixel", () => {
    expect(chromeInsets("android", false)).toEqual({ top: 92, bottom: 0, left: 0, right: 0 });
    expect(chromeInsets("android", true)).toEqual({ top: 44, bottom: 0, left: 44, right: 0 });
  });

  it("iPhone deitado não desenha faixa nem ilha em volta da página", () => {
    const html = renderToStaticMarkup(createElement(PhoneChrome, { platform: "ios", landscape: true, children: createElement("i") }));
    expect(html).not.toContain("data-phone-strip");
    expect(html).not.toContain("rounded-full bg-black");
  });

  it("Android deitado: a faixa da câmera vai de ponta a ponta e o furo fica no meio dela", () => {
    const html = renderToStaticMarkup(createElement(PhoneChrome, { platform: "android", landscape: true, children: createElement("i") }));
    const strip = html.indexOf("data-phone-strip");
    const bar = html.indexOf("<button");
    expect(strip).toBeGreaterThanOrEqual(0);
    expect(strip).toBeLessThan(bar);
    expect(html).toMatch(/data-phone-strip[^>]*class="[^"]*h-full/);
  });

  it("não usa cor fixa: o tema escuro vem dos tokens", () => {
    expect(chromeSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(chromeSource).not.toContain("bg-white\"");
    expect(stageSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
