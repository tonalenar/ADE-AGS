import { describe, expect, it } from "vitest";

import { summarizeSnapshot, SUMMARY_BUDGET } from "../finalSummary";

const HEADER = 'page: "Wikipedia" https://pt.wikipedia.org/wiki/Brasil\nviewport: 1920×1080 · scroll 0/9000\n';

/** Uma página como a Wikipedia: um menu enorme antes do conteúdo, a caixa lateral dentro do main e um rodapé. */
function wikiPage(menuLinks = 220): string {
  const menu = Array.from({ length: menuLinks }, (_, i) => `    - link "Menu do portal número ${i} com um nome longo" [ref=e${i + 1}] → /wiki/Portal:${i}`);
  return [
    HEADER,
    "- banner",
    '  - link "Wikipédia" [ref=e0] → /',
    "- navigation",
    ...menu,
    "- main",
    '  - heading "Brasil" [level=1]',
    '  - text "O Brasil é o maior país da América do Sul."',
    "  - table",
    '    - cell "Capital"',
    '    - cell "Brasília"',
    '    - cell "População"',
    '    - cell "212 milhões de habitantes"',
    "- contentinfo",
    '  - link "Política de privacidade" [ref=e900] → /privacidade',
  ].join("\n");
}

describe("summarizeSnapshot: o resumo final prioriza o objetivo e a região principal (O4)", () => {
  it("uma página que cabe sai exatamente como veio", () => {
    const small = `${HEADER}\n- main\n  - heading "Oi"`;
    expect(summarizeSnapshot(small, "qualquer coisa")).toBe(small);
  });

  it("o corte antigo perdia a caixa lateral; o resumo a traz", () => {
    const page = wikiPage();
    expect(page.slice(0, SUMMARY_BUDGET)).not.toContain("212 milhões");
    const summary = summarizeSnapshot(page, "Qual a população do Brasil?");
    expect(summary).toContain("212 milhões de habitantes");
    expect(summary).toContain('heading "Brasil"');
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_BUDGET);
  });

  it("mesmo sem palavra em comum com o objetivo, o main vem antes do menu", () => {
    const summary = summarizeSnapshot(wikiPage(), "Clique no botão azul");
    expect(summary).toContain('cell "Brasília"');
    expect(summary).toContain('heading "Brasil"');
    // O menu entra no que sobra, mas o conteúdo principal não é sacrificado por ele.
    expect(summary.indexOf('heading "Brasil"')).toBeGreaterThan(summary.indexOf("- navigation"));
  });

  it("a ordem da página é mantida e os saltos são avisados", () => {
    const summary = summarizeSnapshot(wikiPage(), "população");
    const lines = summary.split("\n");
    expect(lines[0]).toBe('page: "Wikipedia" https://pt.wikipedia.org/wiki/Brasil');
    expect(lines.some((l) => /… \d+ linhas omitidas/.test(l))).toBe(true);
    expect(summary).toMatch(/linhas não couberam \(\d+ do menu, cabeçalho ou rodapé\)/);
    expect(summary).toContain("resumo: a página é grande");
  });

  it("um dialog aberto (a camada de cima) tem prioridade sobre o main", () => {
    const filler = Array.from({ length: 160 }, (_, i) => `  - link "Produto de vitrine número ${i} muito comprido" [ref=e${i + 1}] → /p/${i}`);
    const page = [
      HEADER, "- main", ...filler,
      "- dialog", '  - heading "Aceitar cookies?"', '  - button "Aceitar todos" [ref=e500]', '  - button "Recusar" [ref=e501]',
    ].join("\n");
    const summary = summarizeSnapshot(page, "Abrir o produto 3");
    expect(summary).toContain('button "Aceitar todos" [ref=e500]');
    expect(summary).toContain('button "Recusar" [ref=e501]');
  });

  it("uma página sem regiões (tudo solto) ainda traz as linhas do objetivo, não só o começo", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- text "linha de enchimento sem importância ${i} ${"x".repeat(20)}"`);
    lines.splice(380, 0, '- link "Finalizar pedido de teste" [ref=e77] → /checkout');
    const summary = summarizeSnapshot([HEADER, ...lines].join("\n"), "Finalizar pedido");
    expect(summary).toContain('link "Finalizar pedido de teste" [ref=e77]');
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_BUDGET);
  });

  it("nunca passa do orçamento, mesmo com muitos saltos", () => {
    const lines = Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? `- link "produto camiseta ${i}" [ref=e${i}]` : `- text "ruído ${i} ${"y".repeat(30)}"`));
    const summary = summarizeSnapshot([HEADER, ...lines].join("\n"), "camiseta");
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_BUDGET);
  });

  it("o main dentro de um dialog conta como a camada de cima, e a ordem relativa se mantém", () => {
    const page = [HEADER, "- navigation", ...Array.from({ length: 120 }, (_, i) => `  - link "Menu ${i} ${"z".repeat(40)}" [ref=e${i}]`), "- dialog", "  - main", '    - button "Confirmar" [ref=e9]'].join("\n");
    const summary = summarizeSnapshot(page, "nada a ver");
    expect(summary).toContain('button "Confirmar" [ref=e9]');
  });
});
