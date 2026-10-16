import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResponsiveStage } from "../ResponsiveStage";

const render = (viewport: { width: number; height: number } | null, zoom = 1) =>
  renderToStaticMarkup(createElement(ResponsiveStage, { viewport, onResize: () => {}, zoom, children: createElement("iframe") }));

/**
 * Medido ao vivo: o contêiner da página 1920 px tem `overflow: hidden`, que o navegador ainda ROLA (foco ou
 * scrollIntoView dentro do iframe). Com `scrollLeft` 566 o iframe saía 566 px para fora da coluna e a foto do piloto vinha
 * «623×688 de uma página de 1179×688». `overflow: clip` não é um contêiner de rolagem: nada o desloca.
 */
describe("o palco da página nunca rola sozinho", () => {
  it("1920×1080 (preenche a janela): o contêiner e o palco cortam sem rolar", () => {
    const html = render({ width: 1920, height: 1080 });
    expect(html).toContain("overflow:clip");
    expect(html).not.toContain("overflow:hidden");
    expect(html).not.toContain("overflow-hidden");
  });

  it("sem tamanho escolhido (a guia inteira, com ou sem zoom): também corta sem rolar", () => {
    for (const zoom of [1, 0.5, 2]) {
      const html = render(null, zoom);
      expect(html).toContain("overflow:clip");
      expect(html).not.toContain("overflow:hidden");
    }
  });
});
