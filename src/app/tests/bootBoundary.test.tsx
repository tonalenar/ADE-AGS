/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  phase: "ready" as "ready" | "upgrading",
  boomShell: false,
  boomBoot: false,
  terminal: { montagens: 0, desmontagens: 0 },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (harness.boomBoot && key.startsWith("boot.")) throw new Error("boot quebrou");
      return key;
    },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve({ phase: harness.phase }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@/app/splash", () => ({ revealApp: () => undefined }));
vi.mock("@/app/App", async () => {
  const { useEffect } = await import("react");
  const { PanelBoundary } = await import("@/app/PanelBoundary");
  function TerminalStub() {
    useEffect(() => {
      harness.terminal.montagens += 1;
      return () => { harness.terminal.desmontagens += 1; };
    }, []);
    return <div data-testid="terminal-stub" />;
  }
  function Boom(): never {
    throw new Error("casca quebrou");
  }
  return {
    default: function AppStub() {
      return (
        <>
          <TerminalStub />
          <PanelBoundary name="canvas">
            {harness.boomShell ? <Boom /> : <p>casca ok</p>}
          </PanelBoundary>
        </>
      );
    },
  };
});

import { AppTree } from "@/app/AppTree";

async function assentar() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

describe("fronteira do boot e a casca", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    harness.phase = "ready";
    harness.boomShell = false;
    harness.boomBoot = false;
    harness.terminal.montagens = 0;
    harness.terminal.desmontagens = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("erro na casca não desmonta o terminal", async () => {
    harness.boomShell = true;
    act(() => {
      root.render(<AppTree appReady={Promise.resolve()} />);
    });
    await assentar();
    expect(host.querySelector("[data-testid=terminal-stub]")).not.toBeNull();
    expect(harness.terminal.montagens).toBe(1);
    expect(harness.terminal.desmontagens).toBe(0);
    expect(host.textContent).toContain("app.panelError.title");
    expect(host.querySelector("[data-panel-boundary=boot]")).toBeNull();
  });

  it("erro no boot pré-casca mostra o aviso e não pinta a casca", async () => {
    harness.phase = "upgrading";
    harness.boomBoot = true;
    act(() => {
      root.render(<AppTree appReady={Promise.resolve()} />);
    });
    await assentar();
    expect(host.textContent).toContain("app.panelError.title");
    expect(host.querySelector("[data-testid=terminal-stub]")).toBeNull();
    expect(harness.terminal.montagens).toBe(0);
  });
});
