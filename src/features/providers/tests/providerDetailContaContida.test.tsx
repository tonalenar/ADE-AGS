/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContasSection } from "@/features/accounts/ContasSection";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { ProviderDetail } from "@/features/providers/ProviderDetail";
import type { AgentInfo } from "@/features/tabs/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const estado = vi.hoisted(() => ({ montagens: 0, desmontagens: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/features/agents/ipc", () => ({
  agentInstall: async () => ({}),
  agentInstallOffers: async () => [],
  agentUpdatesCheck: async () => [],
  detectAgents: async () => [],
}));
vi.mock("@/features/agents/AgentUpdateWatcher", () => ({
  reasonText: () => "",
  runAgentUpdate: async () => ({}),
}));
vi.mock("@/features/accounts/LoginTerminal", async () => {
  const { useEffect } = await import("react");
  return {
    LoginTerminal: function LoginTerminalStub() {
      useEffect(() => {
        estado.montagens += 1;
        return () => {
          estado.desmontagens += 1;
        };
      }, []);
      return <div data-testid="login-terminal" />;
    },
  };
});

const conta: AgentAccount = {
  id: "conta-1",
  agentId: "claude-code",
  name: "pessoal",
  dir: "/tmp/conta",
  envVar: "CLAUDE_CONFIG_DIR",
  loginCommand: "claude login",
  loggedIn: false,
  label: null,
  createdAt: 0,
  kind: "login",
  baseUrl: null,
  keyHint: null,
};

const agente: AgentInfo = { id: "claude-code", label: "Claude Code", command: "claude", available: true, version: "1.0.0" };

async function descarregar() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

function botao(rotulo: string): HTMLButtonElement {
  const achado = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().includes(rotulo));
  if (!achado) throw new Error(`botão "${rotulo}" não encontrado`);
  return achado;
}

describe("ProviderDetail e ContasSection: contenção do terminal de login", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    estado.montagens = 0;
    estado.desmontagens = 0;
    useAccountsStore.setState({
      accounts: [conta],
      systemAccounts: [],
      capable: [{ agentId: "claude-code", label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", installed: true }],
      health: {},
      loaded: true,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useAccountsStore.setState({ accounts: [], systemAccounts: [], capable: [], health: {} });
    vi.restoreAllMocks();
  });

  it("ProviderDetail não gerencia contas e direciona para Contas", async () => {
    const onOpenAccounts = vi.fn();
    act(() => {
      root.render(
        <ThemeProvider>
          <ProviderDetail agent={agente} onBack={() => {}} onOpenAccounts={onOpenAccounts} />
        </ThemeProvider>,
      );
    });
    await descarregar();
    expect(document.querySelector('[data-testid="login-terminal"]')).toBeNull();
    act(() => { botao("providers.detail.manageInAccounts").click(); });
    expect(onOpenAccounts).toHaveBeenCalledWith("claude-code");
  });

  it("em ContasSection, alternar 'Mostrar o terminal do login' não remonta nem mata o PTY", async () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <ContasSection initialProvider="claude-code" />
        </ThemeProvider>,
      );
    });
    await descarregar();

    act(() => { botao("providers.account.signIn").click(); });
    await descarregar();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);

    // Mostrar e ocultar o terminal do login não desmonta o <LoginTerminal>.
    act(() => { botao("settings.accounts.login.showTerminal").click(); });
    await descarregar();
    act(() => { botao("settings.accounts.login.hideTerminal").click(); });
    await descarregar();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);
  });
});
