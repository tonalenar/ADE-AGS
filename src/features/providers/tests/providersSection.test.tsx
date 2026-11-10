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

const mount = async () => { await act(async () => { root.render(<ProvidersSection />); }); };
const text = () => host.textContent ?? "";
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };

describe("ProvidersSection", () => {
  it("lista os agentes com versão e estado, sem o terminal de emergência", async () => {
    await mount();
    expect(text()).toContain("Claude Code");
    expect(text()).toContain("v2.1.0");
    expect(text()).toContain("v1.5.5");
    expect(text()).toContain('providers.status.authenticated {"label":"ana@exemplo.com","extra":0}');
    // Antigravity: conta própria sem login → sem login; Cursor: programa não achado.
    expect(text()).toContain("providers.status.notAuthenticated");
    expect(text()).toContain("providers.status.notFound");
    expect(text()).not.toContain("Terminal (bash)");
  });

  it("a chave liga/desliga grava a lista dos desativados e mostra o aviso", async () => {
    await mount();
    const toggle = host.querySelector('button[role="switch"][aria-label*="Antigravity"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    expect(useProvidersStore.getState().disabled).toEqual(["antigravity"]);
    expect(JSON.parse(saved["providers.disabled"])).toEqual(["antigravity"]);
    expect(text()).toContain("providers.status.disabled");
    expect(text()).toContain("providers.disabledNote");
  });

  it("'Adicionar provedor' oferece só os agentes que aceitam contas separadas", async () => {
    await mount();
    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("providers.add")));
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual(["Claude Code", "Antigravity"]);
  });

  it("o detalhe do Antigravity mostra as contas, o aviso experimental e as chaves de API indisponíveis", async () => {
    await mount();
    await click(host.querySelector('button[aria-label*="Antigravity"]:not([role="switch"])'));
    expect(text()).toContain("providers.setup.runtime");
    expect(text()).toContain("pessoal");
    expect(text()).toContain("providers.account.agyNote");
    expect(text()).toContain("providers.account.isolation");
    const radios = [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(radios.map((r) => [r.textContent?.includes("antigravity.login"), r.disabled])).toEqual([[true, false], [false, true], [false, true]]);
    expect(text()).toContain("providers.method.unavailable.agy");
    // A conta sem login oferece "Entrar"; a do sistema nunca oferece remover.
    expect(text()).toContain("providers.account.signIn");
    expect(text()).toContain("providers.account.remove");
  });

  it("voltar leva de novo à lista", async () => {
    await mount();
    await click(host.querySelector('button[aria-label*="Claude Code"]:not([role="switch"])'));
    expect(text()).toContain("providers.detail.status");
    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("providers.back")));
    expect(text()).toContain("providers.list");
  });
});
