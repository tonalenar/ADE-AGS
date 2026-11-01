import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

/**
 * A rolagem dos painéis da direita depende da CADEIA de alturas: todo pai entre a coluna de altura fixa e
 * o miolo que rola precisa ser flex em coluna com `min-h-0` (senão o miolo cresce com o conteúdo e a roda
 * não tem o que rolar). Provado num navegador de verdade: com o dock sem `flex`, `clientHeight == scrollHeight`
 * e nada rola; com ele, o miolo rola e a barra tem largura 0.
 */
describe("os painéis da direita rolam (sem barra visível)", () => {
  const summary = read("../summary/SummaryPane.tsx");

  it("o dock do Resumo é uma coluna flex de altura fixa pelas bordas, e o Resumo ocupa o resto", () => {
    expect(summary).toMatch(/absolute top-\[52px\] right-3 z-20 flex flex-col min-h-0/);
    expect(summary).toMatch(/<div className="flex-1 min-h-0 cc-scroll-hidden p-3 flex flex-col gap-3">/);
  });

  it("o ChatShell usa o dock (e não um div solto sem flex)", () => {
    const shell = read("../ChatShell.tsx");
    expect(shell).toMatch(/<SummaryDock overlay=\{summarySpot === "overlay"\}>/);
    expect(shell).not.toMatch(/absolute top-\[52px\] bottom-0 right-3 z-10" style/);
  });

  it("o painel Time e o rascunho: a lista é o miolo que rola, com min-h-0 e flex-1", () => {
    for (const file of ["../team/TeamPanel.tsx", "../team/DraftTeamPanel.tsx"]) {
      expect(read(file), file).toMatch(/cc-scroll-hidden min-h-0 flex-1/);
    }
  });

  it("o dock das outras superfícies: a coluna e o miolo são flex em coluna com min-h-0", () => {
    const dock = read("../RightPanel.tsx");
    expect(dock).toMatch(/h-full flex flex-col border-l/);
    expect(dock).toMatch(/flex-1 min-h-0 flex flex-col outline-none/);
    expect(dock).toMatch(/flex-1 min-h-0 cc-scroll-hidden/);
  });
});
