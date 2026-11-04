// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { agentIcon } from "../agentIcons";
import { CursorIcon } from "../brandIcons";

/**
 * O logo do Cursor é o cubo hexagonal com a seta facetada (o do ícone do Cursor.app), não a seta de mouse
 * genérica que havia antes. Vetor monocromático (`currentColor` + opacidades): pega a cor de onde está.
 */
describe("o logo do Cursor", () => {
  const html = renderToStaticMarkup(<CursorIcon className="w-4 h-4" />);

  it("é o cubo hexagonal com a seta: o hexágono em duas faces e a seta em duas facetas", () => {
    expect(html.match(/<polygon/g)?.length).toBe(4);
    // vértices do hexágono (topo, direita, base, esquerda) e o ápice da seta
    expect(html).toContain("256,108");
    expect(html).toContain("256,405");
    expect(html).toContain("262,392");
  });

  it("não é a seta de mouse antiga (um único path)", () => {
    expect(html).not.toContain("<path");
  });

  it("é monocromático (sem hex): pega a cor do texto e do ladrilho", () => {
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(html).toContain('aria-hidden="true"');
  });

  it("vale em todo lugar onde o app escolhe o ícone do agente (id e comando)", () => {
    expect(agentIcon("cursor")).toBe(CursorIcon);
    expect(agentIcon("", "cursor-agent")).toBe(CursorIcon);
  });
});
