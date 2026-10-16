// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { hideCovers, hideElement, overlayRootOf } from "../annotate/cover";

describe("hideCovers: tirar do caminho o que cobre a página, só pelo tempo da foto", () => {
  it("esconde a raiz de cada coisa que cobre e, ao restaurar, devolve na ordem inversa", () => {
    const log: string[] = [];
    const visible = new Set(["usage", "dock"]);
    const result = hideCovers<string>({
      blockers: () => [...visible],
      rootOf: (n) => n,
      hide: (n) => { visible.delete(n); log.push(`hide ${n}`); return () => { visible.add(n); log.push(`show ${n}`); }; },
    });
    expect(result.hidden).toEqual(["usage", "dock"]);
    expect(visible.size).toBe(0);
    result.restore();
    expect(log).toEqual(["hide usage", "hide dock", "show dock", "show usage"]);
    expect([...visible].sort()).toEqual(["dock", "usage"]);
  });

  it("restaurar duas vezes não desfaz duas vezes", () => {
    const log: string[] = [];
    const result = hideCovers<string>({
      blockers: () => ["a"], rootOf: (n) => n, hide: (n) => { log.push(`hide ${n}`); return () => log.push(`show ${n}`); },
    });
    result.restore();
    result.restore();
    expect(log).toEqual(["hide a", "show a"]);
  });

  it("uma raiz escondida pode revelar outra por baixo: olha de novo, até o limite de rodadas", () => {
    const hidden = new Set<string>();
    const layers = ["top", "middle", "bottom"];
    const result = hideCovers<string>({
      blockers: () => layers.filter((l) => !hidden.has(l)).slice(0, 1),
      rootOf: (n) => n,
      hide: (n) => { hidden.add(n); return () => hidden.delete(n); },
      maxRounds: 2,
    });
    expect(result.hidden).toEqual(["top", "middle"]);
    expect(hidden.size).toBe(2);
    result.restore();
    expect(hidden.size).toBe(0);
  });

  it("o que não tem raiz (a própria página, quem a envolve) nunca é escondido", () => {
    const hidden: string[] = [];
    const result = hideCovers<string>({
      blockers: () => ["page-wrapper"], rootOf: () => null, hide: (n) => { hidden.push(n); return () => {}; },
    });
    expect(result.hidden).toEqual([]);
    expect(hidden).toEqual([]);
  });

  it("não esconde a interface toda por uma foto: há um teto de raízes", () => {
    const result = hideCovers<number>({
      blockers: () => [1, 2, 3, 4, 5, 6, 7, 8, 9], rootOf: (n) => n, hide: () => () => {}, maxHidden: 4,
    });
    expect(result.hidden).toHaveLength(4);
    result.restore();
  });

  it("se esconder falha no meio, o que já foi escondido volta e o erro sobe", () => {
    const log: string[] = [];
    expect(() => hideCovers<string>({
      blockers: () => ["a", "b"],
      rootOf: (n) => n,
      hide: (n) => { if (n === "b") throw new Error("falhou"); log.push(`hide ${n}`); return () => log.push(`show ${n}`); },
    })).toThrow("falhou");
    expect(log).toEqual(["hide a", "show a"]);
  });
});

describe("overlayRootOf e hideElement, no DOM", () => {
  const build = () => {
    document.body.innerHTML = `
      <div id="app">
        <div id="canvas"><div id="node"><div id="column"><iframe id="page"></iframe></div></div></div>
        <aside id="panel"><section id="usage"><span id="label"></span></section></aside>
      </div>`;
    const $ = (id: string) => document.getElementById(id)!;
    return { $, page: $("page") };
  };

  it("sobe até o ramo do painel que não contém a página", () => {
    const { $, page } = build();
    expect(overlayRootOf($("label"), page)).toBe($("panel"));
  });

  it("não devolve raiz para a página, o que está dentro dela ou o que a envolve", () => {
    const { $, page } = build();
    expect(overlayRootOf(page, page)).toBeNull();
    expect(overlayRootOf($("column"), page)).toBeNull();
    expect(overlayRootOf($("canvas"), page)).toBeNull();
  });

  it("hideElement esconde e devolve o estilo inline exato de antes (inclusive um valor já posto)", () => {
    const { $ } = build();
    const plain = $("panel");
    const undoPlain = hideElement(plain);
    expect(plain.style.visibility).toBe("hidden");
    undoPlain();
    expect(plain.style.visibility).toBe("");
    expect(plain.getAttribute("style") ?? "").not.toContain("visibility");

    const styled = $("usage");
    styled.style.setProperty("visibility", "visible");
    const undoStyled = hideElement(styled);
    expect(styled.style.visibility).toBe("hidden");
    undoStyled();
    expect(styled.style.visibility).toBe("visible");
  });
});
