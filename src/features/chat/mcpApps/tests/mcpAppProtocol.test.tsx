/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tauriMocks = vi.hoisted(() => {
  let seq = 0;
  const registered: Array<{ id: string; html: string; policy: string }> = [];
  const invoke = vi.fn(async (cmd: string, args?: { html?: string; policy?: string }) => {
    if (cmd === "design_frame_register") {
      const id = String(++seq).padStart(64, "0");
      registered.push({ id, html: args?.html ?? "", policy: args?.policy ?? "" });
      return id;
    }
    throw new Error(`comando inesperado: ${cmd}`);
  });
  const convertFileSrc = vi.fn((path: string, protocol = "asset") => `${protocol}://localhost/${encodeURIComponent(path)}`);
  const isTauri = vi.fn(() => true);
  return {
    invoke,
    convertFileSrc,
    isTauri,
    registered,
    reset() {
      seq = 0;
      registered.length = 0;
      invoke.mockClear();
      convertFileSrc.mockClear();
      isTauri.mockReturnValue(true);
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  convertFileSrc: tauriMocks.convertFileSrc,
  isTauri: tauriMocks.isTauri,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "pt-BR" } }),
}));

import { clearDesignFrameCache } from "@/shared/ipc/designFrame";

import { McpAppFrame } from "../McpAppFrame";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  tauriMocks.reset();
  clearDesignFrameCache();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("McpAppFrame com protocolo ags-design", () => {
  it("serve o app MCP por ags-design (política isolated) sem srcdoc e mantém sandbox allow-scripts", async () => {
    await act(async () => {
      root.render(<McpAppFrame html="<button onclick='1'>app</button>" server="clima" />);
    });

    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.hasAttribute("srcdoc")).toBe(false);
    expect(iframe?.getAttribute("src")).toMatch(/^ags-design:\/\/localhost\/[0-9a-f]{64}$/);
    expect(tauriMocks.registered).toHaveLength(1);
    expect(tauriMocks.registered[0]?.policy).toBe("isolated");
    expect(tauriMocks.registered[0]?.html).toContain("ags-mcp-app");

    const ev = new MessageEvent("message", { data: { source: "ags-mcp-app", kind: "navigate-away" } });
    Object.defineProperty(ev, "source", { value: iframe!.contentWindow });
    await act(async () => {
      window.dispatchEvent(ev);
    });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("chat.mcpApp.stopped");
  });
});
