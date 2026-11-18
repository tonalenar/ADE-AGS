/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import type { AgentInfo } from "@/features/tabs/types";
import { ProviderDetail } from "@/features/providers/ProviderDetail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `quebrar` faz uma linha da seção de status lançar no re-render em que o login abre.
// `montagens`/`desmontagens` contam o terminal de login (um PTY).
// `quebrarAdicao` faz o diálogo "adicionar conta" lançar quando é aberto (com o login já aberto).
const estado = vi.hoisted(() => ({ quebrar: false, quebrarAdicao: false, montagens: 0, desmontagens: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
// Irmão do login na seção de status: lança quando `quebrar` está ligado.
vi.mock("@/features/settings/SettingsSection", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/settings/SettingsSection")>();
  const { SettingsRow: LinhaReal } = real;
  return {
    ...real,
    SettingsRow: (props: React.ComponentProps<typeof LinhaReal>) => {
      if (estado.quebrar) throw new Error("linha de status quebrou");
      return <LinhaReal {...props} />;
    },
  };
});

// O diálogo "adicionar conta": um irmão do login, que lança quando é aberto.
vi.mock("@/features/accounts/AddAccountDialog", () => ({
  AddAccountDialog: () => {
    if (estado.quebrarAdicao) throw new Error("adicionar conta quebrou");
    return <div data-testid="adicionar-conta" />;
  },
}));

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

// "claude-code" tem métodos de entrada conhecidos (login e chave), e por isso a seção de método e o botão de adicionar aparecem.
const agente: AgentInfo = { id: "claude-code", label: "Claude Code", command: "claude", available: true, version: "1.0.0" };

/** Deixa as promessas de oferta e atualização resolverem pelas microtarefas. Sem relógio e sem laço de espera. */
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

describe("ProviderDetail: login de conta dentro da página", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    estado.quebrar = false;
    estado.quebrarAdicao = false;
    estado.montagens = 0;
    estado.desmontagens = 0;
    useAccountsStore.setState({
      accounts: [conta],
      systemAccounts: [],
      capable: [{ agentId: "claude-code", label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", installed: true }],
      health: {},
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

  it("login_da_conta_sobrevive_a_erro_da_pagina", async () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <ProviderDetail agent={agente} onBack={() => {}} />
        </ThemeProvider>,
      );
    });
    await descarregar();

    // A seção de status quebra no mesmo render em que o diálogo de login abre.
    estado.quebrar = true;
    act(() => {
      botao("providers.account.signIn").click();
    });
    await descarregar();

    // O conteúdo cai no aviso; o diálogo de login (irmão do conteúdo) e o terminal dele seguem montados.
    expect(host.textContent).toContain("app.panelError.title");
    expect(document.querySelector('[data-testid="login-terminal"]')).not.toBeNull();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);
  });

  it("adicionar_conta_que_lanca_nao_derruba_o_login_aberto", async () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <ProviderDetail agent={agente} onBack={() => {}} />
        </ThemeProvider>,
      );
    });
    await descarregar();

    // O login da conta está aberto (o terminal está montado) quando o "adicionar conta" é aberto e lança.
    act(() => {
      botao("providers.account.signIn").click();
    });
    await descarregar();
    expect(estado.montagens).toBe(1);

    estado.quebrarAdicao = true;
    act(() => {
      botao("providers.account.add").click();
    });
    await descarregar();

    // O erro do diálogo de adicionar fica no próprio aviso; o terminal do login, irmão dele, segue montado.
    expect(host.textContent).toContain("app.panelError.title");
    expect(document.querySelector('[data-testid="login-terminal"]')).not.toBeNull();
    expect(estado.desmontagens).toBe(0);
  });
});
