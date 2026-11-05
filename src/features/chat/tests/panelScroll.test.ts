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

  it("o cartão do Resumo é uma coluna flex de altura limitada, e o Resumo é o miolo que rola", () => {
    expect(read("../summary/SummaryPopover.tsx")).toMatch(/max-h-\[calc\(100%-64px\)\] flex flex-col min-h-0/);
    expect(summary).toMatch(/"flex-1 min-h-0 cc-scroll-hidden py-1 flex flex-col"/);
  });

  it("o Resumo não é coluna do painel nem fica fixo por cima da conversa: é o cartão do ícone", () => {
    expect(read("../RightPanel.tsx")).not.toMatch(/SummaryPane/);
    expect(read("../ChatShell.tsx")).toMatch(/<SummaryPopover onClose=\{closeSummary\}>\s*<SummaryPane inCard /);
    expect(summary).not.toMatch(/SummaryDock/);
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
