/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error flag do react act no happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  let ptySeq = 0;
  return {
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === "pty_create") {
        ptySeq += 1;
        return ptySeq;
      }
      if (cmd === "pty_for_tab") return null;
      return null;
    }),
    resetSeq: () => {
      ptySeq = 0;
    },
  };
});

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
vi.mock("@/features/accounts/ipc", () => ({ accountEnv: async () => ({}) }));
vi.mock("@/shared/ipc/window", () => ({ homeDir: async () => "/tmp" }));
vi.mock("@/features/browser/tabMcp", () => ({
  hasBrowserMcp: () => false,
  withBrowserMcp: async (command: string) => ({ command, env: {} }),
}));
vi.mock("@/features/canvas/store", () => ({ missionOfTab: () => null }));

import { Terminal } from "@/features/terminal/Terminal";

function ptyCreates(): unknown[][] {
  return mocks.invoke.mock.calls.filter((call) => call[0] === "pty_create");
}

function ptyKills(): unknown[][] {
  return mocks.invoke.mock.calls.filter((call) => call[0] === "pty_kill");
}

describe("PTY só ao focar", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    mocks.invoke.mockClear();
    mocks.resetSeq();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("não lança a aba oculta, lança uma vez ao focar e mata ao fechar", async () => {
    const render = (hiddenVisible: boolean) => {
      act(() => {
        root.render(
          <>
            <Terminal tabId="visivel" cwd="/tmp" command="claude" isVisible isActive />
            <Terminal
              tabId="oculta"
              cwd="/tmp"
              command="codex"
              isVisible={hiddenVisible}
              initialScrollback="scroll-salvo"
            />
          </>,
        );
      });
    };

    render(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(ptyCreates()).toHaveLength(1);
    expect(ptyCreates()[0]?.[1]).toMatchObject({ command: "claude" });
    expect(ptyKills()).toHaveLength(0);

    render(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(ptyCreates()).toHaveLength(2);
    expect(ptyCreates()[1]?.[1]).toMatchObject({ command: "codex" });

    act(() => {
      root.render(<Terminal tabId="visivel" cwd="/tmp" command="claude" isVisible isActive />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(ptyKills()).toHaveLength(1);
    expect(ptyKills()[0]?.[1]).toMatchObject({ id: 2 });
  });
});
