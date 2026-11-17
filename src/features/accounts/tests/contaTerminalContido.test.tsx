/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentAccountsPane } from "@/features/accounts/AgentAccountsPane";
import { AntigravityAccountsPane } from "@/features/accounts/AntigravityAccountsPane";
import { useAccountsStore } from "@/features/accounts/store";
import type { AccountCapableAgent, AgentAccount } from "@/features/accounts/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `quebrar` faz o rodapé OAuth lançar no re-render. `montagens`/`desmontagens` contam o terminal de login.
const estado = vi.hoisted(() => ({ quebrar: false, montagens: 0, desmontagens: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/features/agents/ipc", () => ({
  detectAgents: async () => [{ id: "antigravity", available: true }],
}));
vi.mock("@/shared/openExternalUrl", () => ({ openExternalUrl: async () => {} }));
vi.mock("@/features/terminal/LazyTerminal", async () => {
  const { useEffect } = await import("react");
  return {
    Terminal: function TerminalStub() {
      useEffect(() => {
        estado.montagens += 1;
        return () => {
          estado.desmontagens += 1;
        };
      }, []);
      return <div data-testid="agy-terminal" />;
    },
  };
});
vi.mock("@/features/accounts/AntigravityOAuthSection", () => ({
  AntigravityOAuthSection: () => {
    if (estado.quebrar) throw new Error("rodapé OAuth quebrou");
    return null;
  },
}));

// As leituras que o AgentAccountsPane faz ao montar (uso e limites), sem backend.
vi.mock("@/features/accounts/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/accounts/ipc")>()),
  accountUsageSummary: async () => [],
  accountLimitsGet: async () => ({}),
}));
// O login da conta abre o diálogo com este terminal (um PTY). Conta montagens/desmontagens.
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
// Irmão da lista (na mesma fronteira da lista): quebra no re-render em que o login abre.
vi.mock("@/features/accounts/PoolsSection", () => ({
  PoolsSection: () => {
    if (estado.quebrar) throw new Error("pools quebrou");
    return null;
  },
}));

const conta: AgentAccount = {
  id: "conta-1",
  agentId: "claude",
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

const agente: AccountCapableAgent = { agentId: "claude", label: "Claude", envVar: "CLAUDE_CONFIG_DIR", installed: true };

/** Deixa a detecção do agy resolver pelas microtarefas. Sem relógio e sem laço de espera. */
async function descarregar() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

function botao(rotulo: string): HTMLButtonElement {
  const achado = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === rotulo);
  if (!achado) throw new Error(`botão "${rotulo}" não encontrado`);
  return achado;
}

describe("terminal de conta dentro de uma página", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    estado.quebrar = false;
    estado.montagens = 0;
    estado.desmontagens = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("terminal_de_login_sobrevive_a_erro_de_outra_parte_da_pagina", async () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <AntigravityAccountsPane />
        </ThemeProvider>,
      );
    });
    await descarregar();

    // O rodapé OAuth quebra no mesmo render em que o terminal do agy abre.
    estado.quebrar = true;
    act(() => {
      botao("accounts.antigravity.connect").click();
    });
    await descarregar();

    // O rodapé cai no aviso; o terminal de login, que não está no rodapé, segue montado.
    expect(host.textContent).toContain("app.panelError.title");
    expect(document.querySelector('[data-testid="agy-terminal"]')).not.toBeNull();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);
  });
});

describe("AgentAccountsPane: login de conta dentro da página", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    estado.quebrar = false;
    estado.montagens = 0;
    estado.desmontagens = 0;
    // A página lê as contas da store (quem as carrega é a tela de contas, não a página).
    useAccountsStore.setState({ accounts: [conta], systemAccounts: [] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useAccountsStore.setState({ accounts: [], systemAccounts: [] });
    vi.restoreAllMocks();
  });

  it("login_da_conta_sobrevive_a_erro_da_lista", async () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <AgentAccountsPane agent={agente} />
        </ThemeProvider>,
      );
    });
    await descarregar();

    // A lista quebra no mesmo render em que o diálogo de login abre.
    estado.quebrar = true;
    act(() => {
      botao("settings.accounts.login.btn").click();
    });
    await descarregar();

    // A lista cai no aviso; o diálogo de login (irmão da lista) e o terminal dele seguem montados.
    expect(host.textContent).toContain("app.panelError.title");
    expect(document.querySelector('[data-testid="login-terminal"]')).not.toBeNull();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);
  });
});
