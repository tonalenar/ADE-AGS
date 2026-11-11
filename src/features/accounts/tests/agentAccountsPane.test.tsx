import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useAccountsStore } from "@/features/accounts/store";
import { AgentAccountsPane } from "@/features/accounts/AgentAccountsPane";

/**
 * A tela de contas só lista TUIs com perfil (HOME isolado). Ela chamava `accountFormMode` sem dizer isso,
 * e o Antigravity caía no OAuth do app: botão "Adicionar conta" desligado e «o programa não está nesta máquina»,
 * mesmo com o `agy` instalado e a conta principal conectada.
 */
describe("contas de uma TUI", () => {
  it("com o Antigravity na máquina, adicionar conta fica ativo", () => {
    useAccountsStore.setState({ accounts: [], systemAccounts: [] });
    const html = renderToStaticMarkup(createElement(AgentAccountsPane, {
      agent: { agentId: "antigravity", label: "Antigravity", envVar: "HOME", installed: true },
    }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).not.toContain("disabled=\"\"");
    expect(html).not.toContain("settings.accounts.add.needsProgram");
  });
});
