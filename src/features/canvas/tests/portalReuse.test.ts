import { describe, expect, it } from "vitest";

import { orphanPortal } from "../portalReuse";

const box = { x: 0, y: 0, w: 640, h: 400 };
const portal = (url: string, kind?: "android") => ({ name: "n", url, box, ...(kind ? { kind } : {}) });

describe("navegador sem dono no canvas", () => {
  const board = {
    portals: {
      "portal-a": portal("http://localhost:8765/gen/loja.html"),
      "portal-b": portal("https://pt.wikipedia.org/wiki/X"),
      "portal-c": portal("http://localhost:8765/gen/loja2.html"),
      "portal-cel": portal("", "android"),
    },
    edges: [
      { id: "e1", a: "tab-viva", b: "portal-a" },
      { id: "e2", a: "tab-fechada", b: "portal-b" },
    ],
  };

  it("o conectado a uma aba aberta não é sem dono; o de uma aba fechada é; a tela do Android nunca", () => {
    const open = new Set(["tab-viva"]);
    // sem endereço: o mais recente dos sem dono (c), nunca o do Android nem o da aba viva
    expect(orphanPortal(board, open)).toBe("portal-c");
    // com endereço: o que já está na mesma origem
    expect(orphanPortal(board, open, "https://pt.wikipedia.org/wiki/Y")).toBe("portal-b");
    expect(orphanPortal(board, open, "http://localhost:8765/gen/loja2.html?f=menu")).toBe("portal-c");
  });

  it("sem nenhum sobrando, nada a reaproveitar", () => {
    const allOpen = new Set(["tab-viva", "tab-fechada", "outra"]);
    const owned = { ...board, portals: { "portal-a": board.portals["portal-a"], "portal-b": board.portals["portal-b"] } };
    expect(orphanPortal(owned, allOpen)).toBeNull();
    expect(orphanPortal({ portals: {}, edges: [] }, new Set())).toBeNull();
  });
});
