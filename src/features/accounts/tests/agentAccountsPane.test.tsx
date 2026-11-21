// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
}));

import { useAccountsStore } from "@/features/accounts/store";
import { AgentAccountsPane } from "@/features/accounts/AgentAccountsPane";
import type { AgentAccount } from "@/features/accounts/types";

const conta = (over: Partial<AgentAccount> = {}): AgentAccount => ({
  id: "acc-kiro0",
  agentId: "antigravity",
  name: "Kiro0",
  dir: "/tmp/accounts/antigravity/Kiro0",
  envVar: "HOME",
  loginCommand: "agy",
  loggedIn: false,
  label: null,
  createdAt: 1,
  kind: "login",
  baseUrl: null,
  keyHint: null,
  displayName: null,
  accentColor: "blue",
  ...over,
});

let root: Root;
let host: HTMLDivElement;

const renderPane = async () => {
  await act(async () => {
    root.render(createElement(AgentAccountsPane, {
      agent: { agentId: "antigravity", label: "Antigravity", envVar: "HOME", installed: true },
    }));
  });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useAccountsStore.setState({ accounts: [], systemAccounts: [], health: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

/**
 * A tela de contas só lista TUIs com perfil (HOME isolado). Ela chamava `accountFormMode` sem dizer isso,
 * e o Antigravity caía no OAuth do app: botão "Adicionar conta" desligado e «o programa não está nesta máquina»,
 * mesmo com o `agy` instalado e a conta principal conectada.
 */
describe("contas de uma TUI", () => {
  it("com o Antigravity na máquina, adicionar conta fica ativo", async () => {
    await renderPane();
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.disabled).toBe(false);
    expect(host.textContent).not.toContain("settings.accounts.add.needsProgram");
  });

  it("não mostra status contraditório (Não conectado + Funcionando) quando a verificação deu ok", async () => {
    useAccountsStore.setState({
      accounts: [conta({ id: "acc-kiro0", name: "Kiro0", loggedIn: false })],
      systemAccounts: [],
      health: {
        "acc-kiro0": { status: "ok", detail: "12 models", email: "kiro@example.com", plan: null, checkedAt: 10 },
      },
    });
    await renderPane();
    expect(host.textContent).toContain("Kiro0");
    expect(host.textContent).toContain("settings.accounts.health.ok");
    expect(host.textContent).not.toContain("settings.accounts.notLoggedIn");
    expect(host.textContent).toContain("kiro@example.com");
    expect(host.textContent).toContain("settings.accounts.relogin");
    expect(host.textContent).not.toContain("settings.accounts.login.btn");
  });

  it("não duplica o aviso de não conectado quando a verificação já disse not_logged_in", async () => {
    useAccountsStore.setState({
      accounts: [conta({ id: "acc-kiro0", name: "Kiro0", loggedIn: false })],
      systemAccounts: [],
      health: {
        "acc-kiro0": { status: "not_logged_in", detail: "Not signed in", email: null, plan: null, checkedAt: 10 },
      },
    });
    await renderPane();
    expect(host.textContent).toContain("settings.accounts.health.not_logged_in");
    expect(host.textContent).not.toContain("settings.accounts.notLoggedIn");
  });

  it("quebra os badges/ações sem esmagar o nome da conta", async () => {
    useAccountsStore.setState({
      accounts: [conta({ id: "acc-kiro0", name: "Kiro0", loggedIn: true })],
      systemAccounts: [],
      health: {
        "acc-kiro0": { status: "ok", detail: "12 models", email: null, plan: null, checkedAt: 10 },
      },
    });
    await renderPane();
    expect(host.textContent).toContain("Kiro0");
    expect(host.innerHTML).toContain("flex-wrap");
  });
});
