/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "neogestify-ui-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBarRegion } from "@/app/StatusBarRegion";
import { useStatusLoginStore } from "@/app/statusLoginStore";
import type { AgentAccount } from "@/features/accounts/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `quebrar` faz o Pet da barra lançar. `montagens`/`desmontagens` contam o LoginTerminal (um PTY de login).
const estado = vi.hoisted(() => ({ quebrar: false, montagens: 0, desmontagens: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
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
vi.mock("@/shared/brand/Pet", () => ({
  usePetStatus: () => ({ level: 1, progress: 0 }),
  Pet: () => {
    if (estado.quebrar) throw new Error("barra quebrou");
    return null;
  },
}));
vi.mock("@/shared/brand/useMascotState", () => ({
  useMascotState: () => ({ state: "idle", summary: { running: 0, needsYou: 0 } }),
}));
vi.mock("@/app/EnvironmentPill", () => ({ EnvironmentPill: () => null }));
vi.mock("@/features/orchestrator/OrchestratorIndicator", () => ({ OrchestratorIndicator: () => null }));
vi.mock("@/features/runs/FleetIndicator", () => ({ FleetIndicator: () => null }));
vi.mock("@/features/accounts/AccountUsagePopover", () => ({ AccountUsagePopover: () => null }));
vi.mock("@/features/accounts/usage", () => ({ systemAccounts: async () => [] }));

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

function Tela() {
  return (
    <ThemeProvider>
      <MemoryRouter initialEntries={["/"]}>
        <StatusBarRegion repo={null} />
      </MemoryRouter>
    </ThemeProvider>
  );
}

/** Deixa as promessas dos chunks e das ações resolverem pelas microtarefas. Sem relógio e sem laço de espera. */
async function descarregar() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

describe("StatusBarRegion", () => {
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
    useStatusLoginStore.setState({ account: null });
    vi.restoreAllMocks();
  });

  it("barra_quebrada_nao_desmonta_o_login_aberto", async () => {
    // Os chunks da barra e do diálogo são pré-carregados, para o lazy resolver sem I/O durante o teste.
    await import("@/app/StatusBar");
    await import("@/app/StatusBarLoginDialog");
    act(() => {
      root.render(<Tela />);
    });
    await descarregar();

    act(() => {
      useStatusLoginStore.getState().open(conta);
    });
    await descarregar();
    expect(estado.montagens).toBe(1);

    // A barra quebra com o login aberto: re-renderiza com o Pet lançando.
    estado.quebrar = true;
    act(() => {
      root.render(<Tela />);
    });
    await descarregar();

    // Só a barra cai no aviso; o terminal de login, fora da fronteira da barra, segue montado.
    expect(host.textContent).toContain("app.panelError.title");
    expect(estado.desmontagens).toBe(0);
    expect(document.querySelector('[data-testid="login-terminal"]')).not.toBeNull();
  });
});
