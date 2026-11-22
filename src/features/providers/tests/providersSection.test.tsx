/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
const i18nResult = { t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { useAccountsStore } from "@/features/accounts/store";
import type { AccountCapableAgent, AgentAccount } from "@/features/accounts/types";
import { useTabsStore } from "@/features/tabs/store";

import { ProvidersSection } from "../ProvidersSection";
import { useProvidersStore } from "../store";

const claude: AgentAccount = {
  id: "system:claude-code", agentId: "claude-code", name: "Claude Code", dir: "/h/.claude", envVar: "CLAUDE_CONFIG_DIR",
  loginCommand: "claude", loggedIn: true, label: "ana@exemplo.com", createdAt: 0, kind: "login", baseUrl: null, keyHint: null,
};
const agyAccount: AgentAccount = {
  id: "ag1", agentId: "antigravity", name: "pessoal", dir: "/data/accounts/antigravity/pessoal", envVar: "HOME",
  loginCommand: "agy", loggedIn: false, label: null, createdAt: 1, kind: "login", baseUrl: null, keyHint: null,
};
const capable: AccountCapableAgent[] = [
  { agentId: "claude-code", label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", installed: true },
  { agentId: "antigravity", label: "Antigravity", envVar: "HOME", installed: true },
];

let host: HTMLDivElement;
let root: Root;
let saved: Record<string, string>;

beforeEach(() => {
  saved = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, string>) => {
    if (cmd === "list_agent_accounts") return [agyAccount];
    if (cmd === "system_accounts") return [claude];
    if (cmd === "account_capable_agents") return capable;
    if (cmd === "db_get_setting") return saved[args!.key] ?? null;
    if (cmd === "db_set_setting") { saved[args!.key] = args!.value; return undefined; }
    if (cmd === "agent_install_offers" || cmd === "agent_updates_check") return [];
    if (cmd === "agent_search_path") return null;
    return undefined;
  });
  useAccountsStore.setState({ accounts: [], systemAccounts: [], capable: [], loaded: false, health: {} });
  useProvidersStore.setState({ disabled: [], loaded: false });
  useTabsStore.setState({
    detectedAgents: [
      { id: "claude-code", label: "Claude Code", command: "claude", available: true, version: "2.1.0 (Claude Code)", path: "/bin/claude" },
      { id: "antigravity", label: "Antigravity", command: "agy", available: true, version: "1.5.5", path: "/bin/agy" },
      { id: "cursor", label: "Cursor", command: "cursor-agent", available: false },
      { id: "bash", label: "Terminal (bash)", command: "bash", available: true },
    ],
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async (onOpenAccounts?: (agentId?: string) => void) => {
  await act(async () => { root.render(<ProvidersSection onOpenAccounts={onOpenAccounts} />); });
};
const text = () => host.textContent ?? "";
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };

describe("ProvidersSection (aba Agentes)", () => {
  it("lista os agentes com versão, nº de contas e estado, inclui atualização automática e omite bash", async () => {
    await mount();
    expect(text()).toContain("Claude Code");
    expect(text()).toContain("v2.1.0");
    expect(text()).toContain("v1.5.5");
    expect(text()).toContain("providers.agent.state.ready");
    expect(text()).toContain("providers.agent.state.login");
    expect(text()).toContain("providers.agents.notInstalled");
    expect(text()).toContain("settings.agentUpdates.label");
    expect(text()).not.toContain("Terminal (bash)");
  });

  it("clicar abre o detalhe (Programa, Como entrar, link Gerenciar em Contas) sem gerenciar contas ali", async () => {
    const onOpenAccounts = vi.fn();
    await mount(onOpenAccounts);
    await click(host.querySelector('button[aria-label*="Antigravity"]'));
    expect(text()).toContain("providers.detail.program");
    expect(text()).toContain("/bin/agy");
    expect(text()).toContain("providers.method.title");
    expect(text()).toContain("providers.detail.manageInAccounts");
    // Detalhe não gerencia contas diretamente (sem botões de remover ou verificar conta).
    expect(text()).not.toContain("providers.account.remove");
    expect(text()).not.toContain("settings.accounts.health.check");

    // Clicar em "Gerenciar em Contas" troca para Contas com o agente selecionado.
    const goBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("providers.detail.manageInAccounts"));
    await click(goBtn);
    expect(onOpenAccounts).toHaveBeenCalledWith("antigravity");
  });

  it("a chave liga/desliga no detalhe grava a lista dos desativados e voltar retorna à lista", async () => {
    await mount();
    await click(host.querySelector('button[aria-label*="Antigravity"]'));
    const toggle = host.querySelector('button[role="switch"][aria-label*="Antigravity"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    expect(useProvidersStore.getState().disabled).toEqual(["antigravity"]);
    expect(JSON.parse(saved["providers.disabled"])).toEqual(["antigravity"]);

    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("providers.tab.agents")));
    expect(text()).toContain("providers.agent.state.off");
  });
});
