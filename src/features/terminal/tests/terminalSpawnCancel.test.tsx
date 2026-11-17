/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// O `pty_create` fica pendente até o teste decidir quando o backend responde. Isso reproduz o caso em que
// a aba é fechada enquanto o processo ainda está nascendo.
const mocks = vi.hoisted(() => {
  const estado = {
    liberarCriacao: null as ((id: number) => void) | null,
    escutas: [] as string[],
    /** Nomes dos listeners que foram soltos (a função devolvida por `listen` foi chamada). */
    soltos: [] as string[],
    /** Quando true, o `listen` só responde depois que o teste chama `resolverListen`. */
    segurarListen: false,
    resolverListen: null as (() => void) | null,
  };
  return {
    estado,
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === "pty_create") {
        return new Promise<number>((resolve) => {
          estado.liberarCriacao = resolve;
        });
      }
      return null;
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (nome: string) => {
    mocks.estado.escutas.push(nome);
    const soltar = () => {
      mocks.estado.soltos.push(nome);
    };
    if (!mocks.estado.segurarListen) return Promise.resolve(soltar);
    return new Promise<() => void>((resolve) => {
      mocks.estado.resolverListen = () => resolve(soltar);
    });
  },
}));
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
    constructor(opts?: Record<string, unknown>) {
      this.options = opts ?? {};
    }
    loadAddon() {}
    open() {}
    write() {}
    reset() {}
    paste() {}
    focus() {}
    onData() {
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
  startSessionDiscovery: () => () => {},
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

import { Terminal } from "@/features/terminal/Terminal";

/** Deixa o spawn andar pelas microtarefas até o `pty_create`. Sem relógio e sem laço de espera. */
async function descarregar() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

function chamadas(comando: string): unknown[][] {
  return mocks.invoke.mock.calls.filter((call) => call[0] === comando);
}

function escutasDePty(): string[] {
  return mocks.estado.escutas.filter((nome) => nome.startsWith("pty-"));
}

describe("spawn do terminal", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    mocks.invoke.mockClear();
    mocks.estado.escutas.length = 0;
    mocks.estado.soltos.length = 0;
    mocks.estado.liberarCriacao = null;
    mocks.estado.segurarListen = false;
    mocks.estado.resolverListen = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("fechar_durante_spawn_mata_o_pty", async () => {
    act(() => {
      root.render(<Terminal tabId="aba" cwd="/tmp" command="claude" isVisible isActive />);
    });
    await descarregar();
    expect(chamadas("pty_create")).toHaveLength(1);

    // A aba fecha antes de o backend responder.
    act(() => root.unmount());
    mocks.estado.liberarCriacao?.(7);
    await descarregar();

    // O PTY que nasceu depois do fechamento é morto, e nenhum listener dele fica registrado.
    expect(chamadas("pty_kill")).toEqual([["pty_kill", { id: 7 }]]);
    expect(escutasDePty()).toEqual([]);
  });

  it("fechar_durante_o_listen_solta_o_listener", async () => {
    // O PTY nasce normalmente, mas o registro do listener de saída fica pendente.
    mocks.estado.segurarListen = true;
    act(() => {
      root.render(<Terminal tabId="aba" cwd="/tmp" command="claude" isVisible isActive />);
    });
    await descarregar();
    mocks.estado.liberarCriacao?.(9);
    await descarregar();
    expect(mocks.estado.resolverListen).not.toBeNull();

    // A aba fecha enquanto o `listen` ainda não respondeu: o cleanup já passou e não viu o listener.
    act(() => root.unmount());
    mocks.estado.resolverListen?.();
    await descarregar();

    // O listener que chegou depois do fechamento é solto na hora, e nenhum outro é registrado.
    expect(mocks.estado.soltos).toEqual(["pty-data-9"]);
    expect(escutasDePty()).toEqual(["pty-data-9"]);
    expect(chamadas("pty_kill")).toEqual([["pty_kill", { id: 9 }]]);
  });

  it("spawn_sem_fechar_segue_e_escuta_a_saida", async () => {
    act(() => {
      root.render(<Terminal tabId="aba" cwd="/tmp" command="claude" isVisible isActive />);
    });
    await descarregar();
    mocks.estado.liberarCriacao?.(8);
    await descarregar();

    // Controle: sem fechar, o PTY não é morto e os listeners dele são registrados.
    expect(chamadas("pty_kill")).toHaveLength(0);
    expect(escutasDePty()).toEqual(["pty-data-8", "pty-exit-8"]);
    act(() => root.unmount());
  });
});
