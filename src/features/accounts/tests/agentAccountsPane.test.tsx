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

  it("cada conta cresce com o conteúdo sem altura fixa, sem overflow-hidden e com ações contidas na própria linha", async () => {
    const principal = conta({
      id: "system:antigravity",
      name: "Antigravity",
      dir: "/Users/teste",
      loggedIn: true,
      accentColor: null,
    });
    const extra = conta({
      id: "acc-kiro0",
      name: "Kiro0",
      label: "kiro@example.com",
      loggedIn: true,
    });
    useAccountsStore.setState({
      systemAccounts: [principal],
      accounts: [extra],
      health: {},
    });
    await renderPane();

    const rows = [...host.querySelectorAll<HTMLElement>("[data-account-row]")];
    expect(rows.map((r) => r.dataset.accountRow)).toEqual(["system:antigravity", "acc-kiro0"]);

    for (const row of rows) {
      const classes = row.className.split(/\s+/);
      // Nunca encolhe dentro de contêiner flex vertical nem prende altura.
      expect(classes).toContain("shrink-0");
      expect(classes).toContain("flex-wrap");
      expect(classes).not.toContain("overflow-hidden");
      expect(classes.some((c) => /^h-(?:\d+|\[[^\]]+\]|px|full|screen)$/.test(c))).toBe(false);
      expect(classes.some((c) => /^max-h-/.test(c))).toBe(false);
      // `min-h-12` sobrescreve `min-height: auto` no flexbox e deixava o WebKit esmagar a linha.
      expect(classes.some((c) => /^min-h-/.test(c))).toBe(false);

      const identity = row.querySelector<HTMLElement>("[data-account-identity]");
      const actions = row.querySelector<HTMLElement>("[data-account-actions]");
      expect(identity).not.toBeNull();
      expect(actions).not.toBeNull();
      expect(row.contains(identity!)).toBe(true);
      expect(row.contains(actions!)).toBe(true);
      expect(identity!.className).toContain("min-w-0");
      expect(identity!.querySelector(".truncate")).not.toBeNull();
      expect(actions!.className).toContain("shrink-0");
      expect(actions!.className).toContain("flex-wrap");

      // Os botões de ação da conta ficam dentro do bloco dela (nunca fora/sobrepostos).
      const labels = [...actions!.querySelectorAll("button")].map(
        (b) => b.textContent?.trim() || b.getAttribute("aria-label") || "",
      );
      expect(labels).toContain("settings.accounts.health.check");
      expect(labels).toContain("settings.accounts.limits.btn");
      expect(labels).toContain("settings.accounts.identity.btn");
      expect(labels).toContain("settings.accounts.relogin");
    }

    // A conta extra também traz o botão de remover dentro do próprio bloco.
    const extraButtons = [...rows[1]!.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") || b.textContent?.trim() || "",
    );
    expect(extraButtons).toContain("settings.accounts.delete.action");

    // O contêiner rolável não pode ser um flex-col que comprima diretamente as linhas.
    const scroller = host.querySelector<HTMLElement>(".cc-scroll");
    expect(scroller).not.toBeNull();
    expect(scroller!.className.split(/\s+/)).not.toContain("flex-col");

    // A seção de pools (quando há 2+ contas) também não pode encolher.
    const poolsSection = host.querySelector<HTMLElement>("section");
    expect(poolsSection).not.toBeNull();
    expect(poolsSection!.className.split(/\s+/)).toContain("shrink-0");

    // Somente tokens de tema: nenhum hex embutido na árvore da conta.
    expect(host.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
