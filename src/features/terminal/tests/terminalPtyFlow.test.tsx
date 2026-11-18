/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag do react act no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  /** Quando true, `pty_write` recusa (fila cheia ou terminal encerrado). */
  writeFails: false,
  /** O `onData` do xterm: é aqui que o `Terminal` manda a entrada do usuário ao PTY. */
  dados: [] as Array<(data: string) => void>,
  webgl: [] as unknown[],
  toasts: [] as Array<{ text: string; tone?: string }>,
  discovery: vi.fn((_opts: unknown) => () => undefined),
  /** Quando true, `pty_create` fica pendente até `resolverCriacao` (para fechar a aba antes do PTY nascer). */
  segurarCriacao: false,
  resolverCriacao: null as null | ((id: number) => void),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("neogestify-ui-components", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    unicode = { activeVersion: "11" };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    constructor(opts?: Record<string, unknown>) {
      this.options = opts ?? {};
    }
    loadAddon() {}
    open() {}
    write() {}
    reset() {}
    paste() {}
    focus() {}
    onData(cb: (data: string) => void) {
      mocks.dados.push(cb);
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    onDimensionsChange() {
      return { dispose() {} };
    }
    dispose() {}
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      mocks.webgl.push(this);
    }
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@/features/terminal/fit", () => ({
  createFitter: () => ({ fit: () => {}, fitOnce: async () => {} }),
}));
vi.mock("@/features/terminal/terminalKeys", () => ({ installTerminalKeyHandler: () => {} }));
vi.mock("@/features/terminal/terminalCapabilities", () => ({
  registerCapabilityResponders: () => () => {},
}));
vi.mock("@/features/terminal/terminalMarks", () => ({ installInputMarks: () => () => {} }));
vi.mock("@/features/terminal/terminalScrollbar", () => ({ keepScrollbarVisible: () => () => {} }));
vi.mock("@/features/terminal/tuiScrollRail", () => ({ installTuiScrollRail: () => () => {} }));
vi.mock("@/features/terminal/sessionDiscovery", () => ({
  LOOKBACK_S: 5,
  startSessionDiscovery: (opts: unknown) => mocks.discovery(opts),
}));
// O registro de agentes não é carregado aqui: o teste precisa de um agente que sabe retomar sessão.
vi.mock("@/features/sessions/agentResume", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sessions/agentResume")>()),
  isResumable: () => true,
}));
vi.mock("@/features/skills/pendingSkillSetup", () => ({ awaitSkillSetup: async () => [] }));
vi.mock("@/features/skills/ipc", () => ({ reconcileTabSkills: async () => {} }));
vi.mock("@/features/prelaunch/ipc", () => ({ resolvePrelaunch: async () => [] }));
vi.mock("@/shared/ipc/window", () => ({ homeDir: async () => "/tmp" }));
vi.mock("@/features/browser/tabMcp", () => ({
  hasBrowserMcp: () => false,
  withBrowserMcp: async (command: string) => ({ command, env: {} }),
}));
vi.mock("@/features/canvas/store", () => ({ missionOfTab: () => null }));
vi.mock("@/features/terminal/ExcerptAction", () => ({ ExcerptAction: () => null }));
vi.mock("@/shared/brand/botToastStore", () => ({
  showBotToast: (input: { text: string; tone?: string }) => {
    mocks.toasts.push(input);
    return 1;
  },
}));

import { Terminal } from "@/features/terminal/Terminal";

/** Deixa as promessas do `Terminal` andarem até o PTY nascer. */
async function flush() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {});
  }
}

describe("Terminal: PTY, descoberta e GPU", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    mocks.writeFails = false;
    mocks.dados.length = 0;
    mocks.webgl.length = 0;
    mocks.toasts.length = 0;
    mocks.discovery.mockClear();
    mocks.segurarCriacao = false;
    mocks.resolverCriacao = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "pty_create") {
        if (mocks.segurarCriacao) {
          return new Promise<number>((resolve) => {
            mocks.resolverCriacao = resolve;
          });
        }
        return 1;
      }
      if (cmd === "pty_write") {
        if (mocks.writeFails) throw new Error("Terminal ocupado: a entrada não foi enviada");
        return null;
      }
      if (cmd === "pty_for_tab") return null;
      void args;
      return null;
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    try {
      act(() => root.unmount());
    } catch {
      // já desmontado pelo próprio teste
    }
    host.remove();
  });

  it("a GPU liga para a terminal que nasce visível, sem esperar uma troca de visibilidade", () => {
    act(() => {
      root.render(<Terminal tabId="t-gpu" cwd="/tmp" command="claude" isVisible isActive />);
    });
    expect(mocks.webgl).toHaveLength(1);
  });

  it("fechar a aba antes de o PTY nascer não deixa a descoberta de sessão rodando", async () => {
    mocks.segurarCriacao = true;
    act(() => {
      root.render(
        <Terminal tabId="t-close" cwd="/tmp" command="claude" agentId="claude-code" isVisible isActive onSessionDiscovered={() => undefined} />,
      );
    });
    await flush();
    act(() => root.unmount());
    // O PTY nasce depois de a aba já ter fechado.
    mocks.resolverCriacao?.(9);
    await flush();
    expect(mocks.discovery).not.toHaveBeenCalled();
  });

  it("uma tecla recusada pelo PTY avisa, uma vez por rajada, e uma escrita aceita reabre o aviso", async () => {
    act(() => {
      root.render(<Terminal tabId="t-key" cwd="/tmp" command="bash" isVisible isActive />);
    });
    await flush();
    const digitar = async (texto: string) => {
      for (const cb of mocks.dados) cb(texto);
      await flush();
    };

    mocks.writeFails = true;
    await digitar("a");
    await digitar("b");
    expect(mocks.toasts).toHaveLength(1);
    expect(mocks.toasts[0]).toMatchObject({ text: "terminal.writeFailed.text", tone: "warning" });

    mocks.writeFails = false;
    await digitar("c");
    mocks.writeFails = true;
    await digitar("d");
    expect(mocks.toasts).toHaveLength(2);
  });
});
