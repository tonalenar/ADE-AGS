/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";
import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Os flags fazem o texto ou o rodapé do passo de login lançarem ao renderizar. `montagens`/`desmontagens`
// contam o terminal de login (um PTY), que é filho do diálogo no passo "criado".
const estado = vi.hoisted(() => ({
  quebrarTitulo: false,
  quebrarTexto: false,
  quebrarRodape: false,
  montagens: 0,
  desmontagens: 0,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (estado.quebrarTitulo && key === "settings.accounts.login.title") throw new Error("título do login quebrou");
      if (estado.quebrarTexto && key === "settings.accounts.login.helper") throw new Error("texto do login quebrou");
      if (estado.quebrarRodape && key === "settings.accounts.login.done") throw new Error("rodapé do login quebrou");
      return key;
    },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
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
  id: "conta-nova",
  agentId: "claude-code",
  name: "conta-nova",
  dir: "/tmp/conta-nova",
  envVar: "CLAUDE_CONFIG_DIR",
  loginCommand: "claude login",
  loggedIn: false,
  label: null,
  createdAt: 0,
  kind: "login",
  baseUrl: null,
  keyHint: null,
};

/** Deixa as atualizações de estado e as promessas resolverem pelas microtarefas. Sem relógio e sem laço de espera. */
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

/** Digita no campo do nome (o primeiro input do diálogo) do jeito que o React enxerga. */
function digitarNome(valor: string) {
  const input = document.querySelector("input");
  if (!input) throw new Error("campo do nome não encontrado");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("setter de value indisponível");
  act(() => {
    setter.call(input, valor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AddAccountDialog: passo de login não derruba o terminal", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    estado.quebrarTitulo = false;
    estado.quebrarTexto = false;
    estado.quebrarRodape = false;
    estado.montagens = 0;
    estado.desmontagens = 0;
    // O agente aceita cadastro (formulário de login disponível); criar a conta devolve a conta de teste.
    useAccountsStore.setState({
      capable: [{ agentId: "claude-code", label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", installed: true }],
      accounts: [],
      create: async () => conta,
      load: async () => {},
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useAccountsStore.setState({ capable: [], accounts: [] });
    vi.restoreAllMocks();
  });

  /** Preenche o nome e cria a conta: o diálogo passa para o passo de login, com o terminal montado. */
  async function chegarAoPassoDeLogin() {
    act(() => {
      root.render(
        <ThemeProvider>
          <AddAccountDialog agentId="claude-code" initialMode="login" onClose={() => {}} />
        </ThemeProvider>,
      );
    });
    await descarregar();
    digitarNome("conta-nova");
    await descarregar();
  }

  it("texto_do_passo_de_login_que_lanca_nao_derruba_o_terminal", async () => {
    await chegarAoPassoDeLogin();

    // O texto do passo de login lança no render em que a conta é criada.
    estado.quebrarTexto = true;
    act(() => {
      botao("settings.accounts.add.continue").click();
    });
    await descarregar();

    // Só o texto cai no aviso; o terminal de login, filho do diálogo, segue montado.
    expect(document.body.textContent).toContain("app.panelError.title");
    expect(document.querySelector('[data-testid="login-terminal"]')).not.toBeNull();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);
  });

  it("rodape_do_passo_de_login_que_lanca_nao_derruba_o_terminal", async () => {
    await chegarAoPassoDeLogin();

    // O rodapé do passo de login lança no render em que a conta é criada.
    estado.quebrarRodape = true;
    act(() => {
      botao("settings.accounts.add.continue").click();
    });
    await descarregar();

    expect(document.body.textContent).toContain("app.panelError.title");
    expect(document.querySelector('[data-testid="login-terminal"]')).not.toBeNull();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);
  });

  it("titulo_do_passo_de_login_que_lanca_nao_derruba_o_terminal", async () => {
    await chegarAoPassoDeLogin();

    // O título do passo de login lança no render em que a conta é criada (o título vai ao cabeçalho do AppDialog).
    estado.quebrarTitulo = true;
    act(() => {
      botao("settings.accounts.add.continue").click();
    });
    await descarregar();

    // Só o título cai no texto simples (o nome da conta); o terminal de login, filho do diálogo, segue montado.
    expect(document.body.textContent).toContain("conta-nova");
    expect(document.body.textContent).not.toContain("app.panelError.title");
    expect(document.querySelector('[data-testid="login-terminal"]')).not.toBeNull();
    expect(estado.montagens).toBe(1);
    expect(estado.desmontagens).toBe(0);
  });
});
