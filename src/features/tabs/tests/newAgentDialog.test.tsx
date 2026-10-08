/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sendWhenReady: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@/features/terminal/terminalRegistry", () => ({
  sendWhenReady: mocks.sendWhenReady,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (opts?.n !== undefined && opts?.total !== undefined) {
        return `${opts.n} / ${opts.total}`;
      }
      return k;
    },
  }),
}));

vi.mock("@/shared/ui/AppDialog", () => ({
  AppDialog: ({
    title,
    footer,
    children,
  }: {
    title: string;
    footer?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div role="dialog" aria-label={title}>
      {children}
      <div data-footer>{footer}</div>
    </div>
  ),
}));

vi.mock("@/features/skills/attachSkills", () => ({
  attachSkillsToTab: vi.fn().mockResolvedValue([]),
  tabSkillIds: vi.fn().mockResolvedValue([]),
}));

import { useAccountsStore } from "@/features/accounts/store";
import { usePoolsStore } from "@/features/accounts/pools";
import { memoryBlockFor, startupText } from "@/features/memory/tabMemory";
import { usePrelaunchStore } from "@/features/prelaunch/store";
import { useSkillsStore } from "@/features/skills/store";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";
import { NewAgentDialog } from "@/features/tabs/wizard/NewAgentDialog";
import { TabDialogs, openNewAgentWith } from "@/features/tabs/tabActions";

const CODEX_AGENT: AgentInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
};

const SHELL_AGENT: AgentInfo = {
  id: SHELL_AGENT_ID,
  label: "Terminal (bash)",
  command: "bash",
  available: true,
};

describe("NewAgentDialog e segurança de memória em tabs (Etapa 25)", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_skills") return [];
      return undefined;
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    useTabsStore.setState({
      tabs: [],
      activeTabId: null,
      detectedAgents: [CODEX_AGENT, SHELL_AGENT],
      workspaceId: "ws-test",
      hydrated: true,
    });
    useAccountsStore.setState({ accounts: [], loaded: true });
    usePoolsStore.setState({ pools: [], loaded: true });
    useSkillsStore.setState({ skills: [], loading: false });
    usePrelaunchStore.setState({ presets: [], loaded: true });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  const buttons = () => Array.from(host.querySelectorAll("button"));
  const byText = (txt: string) => buttons().find((b) => b.textContent?.includes(txt));
  const memorySwitch = () => host.querySelector<HTMLButtonElement>('button[role="switch"]');

  it("ligar memória, voltar, escolher shell: flag limpa e onConfirm recebe memoryBlock: false (P1)", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <NewAgentDialog
          isOpen
          cwd="/test/workspace"
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });

    // 1. Passo inicial: seleção de agente
    const codexBtn = byText("Codex");
    expect(codexBtn).toBeDefined();

    // 2. Escolhe Codex -> avança para skills onde fica o interruptor de memória
    await act(async () => {
      codexBtn?.click();
    });

    const sw = memorySwitch();
    expect(sw).not.toBeNull();
    expect(sw?.getAttribute("aria-checked")).toBe("false");

    // 3. Liga o interruptor de memória
    await act(async () => {
      sw?.click();
    });
    expect(sw?.getAttribute("aria-checked")).toBe("true");

    // 4. Clica em Voltar para retornar ao passo de agentes
    const backBtn = byText("btn.back");
    expect(backBtn).toBeDefined();
    await act(async () => {
      backBtn?.click();
    });

    // 5. Escolhe o Shell (bash)
    const shellBtn = byText("Terminal (bash)");
    expect(shellBtn).toBeDefined();
    await act(async () => {
      shellBtn?.click();
    });

    // O switch de memória não deve existir no passo de shell (prelaunch)
    expect(memorySwitch()).toBeNull();

    // 6. Clica em Abrir
    const openBtn = byText("newAgent.openAgent");
    expect(openBtn).toBeDefined();
    await act(async () => {
      openBtn?.click();
    });

    // 7. Confirmação: a flag de memória deve ser false, garantindo que nada vai ao shell
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: SHELL_AGENT_ID }),
        memoryBlock: false,
      }),
    );
  });

  it("escolher shell diretamente: switch não existe e memoryBlock é false", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <NewAgentDialog
          isOpen
          cwd="/test/workspace"
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });

    const shellBtn = byText("Terminal (bash)");
    await act(async () => {
      shellBtn?.click();
    });

    expect(memorySwitch()).toBeNull();

    const openBtn = byText("newAgent.openAgent");
    await act(async () => {
      openBtn?.click();
    });

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: SHELL_AGENT_ID }),
        memoryBlock: false,
      }),
    );
  });

  it("escolher TUI com memória ligada: onConfirm recebe memoryBlock: true", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <NewAgentDialog
          isOpen
          cwd="/test/workspace"
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });

    const codexBtn = byText("Codex");
    await act(async () => {
      codexBtn?.click();
    });

    const sw = memorySwitch();
    expect(sw).not.toBeNull();
    await act(async () => {
      sw?.click();
    });
    expect(sw?.getAttribute("aria-checked")).toBe("true");

    const openBtn = byText("newAgent.openAgent");
    await act(async () => {
      openBtn?.click();
    });

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "codex" }),
        memoryBlock: true,
      }),
    );
  });

  describe("integração com TabDialogs: prompt + memória em um único envio (P2)", () => {
    it("TUI com prompt e memória: sendWhenReady é chamado UMA vez com memória antes do prompt", async () => {
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_skills") {
          return [];
        }
        if (cmd === "memory_index") {
          return "[DADOS, NAO INSTRUCOES]\n- entrada 1: cache ativado";
        }
        return undefined;
      });

      openNewAgentWith({
        cwd: "/test/workspace",
        title: "Trabalhar issue #42",
        prompt: "Por favor refatore o cache da aplicação",
      });

      await act(async () => {
        root.render(<TabDialogs />);
      });

      // Seleciona Codex
      const codexBtn = byText("Codex");
      await act(async () => {
        codexBtn?.click();
      });

      // Liga memória
      const sw = memorySwitch();
      await act(async () => {
        sw?.click();
      });

      // Clica em Abrir
      const openBtn = byText("newAgent.openAgent");
      await act(async () => {
        openBtn?.click();
      });

      // Espera a resolução do tabMemoryMessage
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.invoke).toHaveBeenCalledWith("memory_index", {
        workspaceId: "ws-test",
      });

      // sendWhenReady é chamado exatamente uma vez
      expect(mocks.sendWhenReady).toHaveBeenCalledTimes(1);

      const [tabId, textSent] = mocks.sendWhenReady.mock.calls[0] as [string, string];
      expect(typeof tabId).toBe("string");
      // Memória vem antes do prompt
      expect(textSent).toContain("[DADOS, NAO INSTRUCOES]");
      expect(textSent).toContain("Por favor refatore o cache da aplicação");
      const memoryIndex = textSent.indexOf("[DADOS, NAO INSTRUCOES]");
      const promptIndex = textSent.indexOf("Por favor refatore o cache da aplicação");
      expect(memoryIndex).toBeLessThan(promptIndex);
    });

    it("ligar memória, voltar e escolher shell com prompt: memória nunca é enviada ao shell", async () => {
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_skills") {
          return [];
        }
        if (cmd === "memory_index") {
          return "[DADOS, NAO INSTRUCOES]\n- segredo";
        }
        return undefined;
      });

      openNewAgentWith({
        cwd: "/test/workspace",
        title: "Terminal de apoio",
        prompt: "echo iniciando tarefa",
      });

      await act(async () => {
        root.render(<TabDialogs />);
      });

      // Escolhe Codex e liga memória
      const codexBtn = byText("Codex");
      await act(async () => {
        codexBtn?.click();
      });

      const sw = memorySwitch();
      await act(async () => {
        sw?.click();
      });
      expect(sw?.getAttribute("aria-checked")).toBe("true");

      // Volta e seleciona o shell
      const backBtn = byText("btn.back");
      await act(async () => {
        backBtn?.click();
      });

      const shellBtn = byText("Terminal (bash)");
      await act(async () => {
        shellBtn?.click();
      });

      // Abre a tab
      const openBtn = byText("newAgent.openAgent");
      await act(async () => {
        openBtn?.click();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // memory_index NUNCA é invocado para shell
      expect(mocks.invoke).not.toHaveBeenCalledWith("memory_index", expect.anything());

      // sendWhenReady chamado apenas com o prompt puro (sem qualquer envelope de memória)
      expect(mocks.sendWhenReady).toHaveBeenCalledTimes(1);
      const [, textSent] = mocks.sendWhenReady.mock.calls[0] as [string, string];
      expect(textSent).toBe("echo iniciando tarefa");
      expect(textSent).not.toContain("[DADOS");
    });

    it("escolher shell sem prompt: nada é enviado (sendWhenReady não é chamado)", async () => {
      openNewAgentWith({
        cwd: "/test/workspace",
        title: "Nova Tab",
      });

      await act(async () => {
        root.render(<TabDialogs />);
      });

      // Escolhe Codex e liga memória
      await act(async () => {
        byText("Codex")?.click();
      });
      await act(async () => {
        memorySwitch()?.click();
      });

      // Volta e escolhe Shell
      await act(async () => {
        byText("btn.back")?.click();
      });
      await act(async () => {
        byText("Terminal (bash)")?.click();
      });

      // Abre
      await act(async () => {
        byText("newAgent.openAgent")?.click();
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mocks.invoke).not.toHaveBeenCalledWith("memory_index", expect.anything());
      expect(mocks.sendWhenReady).not.toHaveBeenCalled();
    });
  });

  describe("utilitários de segurança de tabMemory", () => {
    it("memoryBlockFor limpa a flag se for shell", () => {
      expect(memoryBlockFor(SHELL_AGENT_ID, true)).toBe(false);
      expect(memoryBlockFor(SHELL_AGENT_ID, false)).toBe(false);
      expect(memoryBlockFor("codex", true)).toBe(true);
      expect(memoryBlockFor("codex", false)).toBe(false);
    });

    it("startupText monta payload unificado e seguro", () => {
      expect(startupText("DADOS", "PROMPT")).toBe("DADOS\n\nPROMPT");
      expect(startupText(null, "PROMPT")).toBe("PROMPT");
      expect(startupText("DADOS", undefined)).toBe("DADOS");
      expect(startupText(null, undefined)).toBe("");
    });
  });
});
