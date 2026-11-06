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
    const shell = read("../ChatShell.tsx");
    // Sem painel: a coluna fixa abaixo do cabeçalho (o cabeçalho fica com a largura inteira, acima dela).
    expect(shell).toMatch(/\{summaryPinned && !panelOpen && \(\s*<aside aria-label=\{t\("chat.panel.open.summary"\)\} data-summary-column/);
    // Com painel: o cartão flutuante, menor.
    expect(shell).toMatch(/\{summaryOpen && panelOpen && \(\s*<SummaryPopover width=\{SUMMARY_POPOVER_W\}/);
    expect(shell.indexOf("</header>")).toBeLessThan(shell.indexOf("data-summary-column"));
    // Um pouco menor que antes (420 px): a coluna tem 350 px e encolhe até 280.
    expect(shell).toMatch(/w-\[350px\] min-w-\[280px\] shrink/);
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
