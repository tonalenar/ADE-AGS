/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
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
  const renderRead = vi.fn(async () => "<h1>Relatório</h1><button onclick=\"1\">ok</button>");
  const openExternalUrl = vi.fn();
  return {
    invoke,
    convertFileSrc,
    isTauri,
    renderRead,
    openExternalUrl,
    registered,
    reset() {
      seq = 0;
      registered.length = 0;
      invoke.mockClear();
      convertFileSrc.mockClear();
      isTauri.mockReturnValue(true);
      renderRead.mockClear();
      openExternalUrl.mockClear();
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: mocks.convertFileSrc,
  isTauri: mocks.isTauri,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/shared/openExternalUrl", () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock("../ipc", () => ({ renderRead: mocks.renderRead }));

import { clearDesignFrameCache } from "@/shared/ipc/designFrame";

import { RenderFrame } from "../RenderFrame";
import { RENDER_MESSAGE_SOURCE } from "../model";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.reset();
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

describe("RenderFrame com protocolo ags-design", () => {
  it("serve o HTML publicado por ags-design (política isolated) sem srcdoc e mantém sandbox allow-scripts", async () => {
    await act(async () => {
      root.render(<RenderFrame id="r1" reloadKey={0} title="Relatório" />);
    });

    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.hasAttribute("srcdoc")).toBe(false);
    expect(iframe?.getAttribute("src")).toMatch(/^ags-design:\/\/localhost\/[0-9a-f]{64}$/);
    expect(mocks.registered).toHaveLength(1);
    expect(mocks.registered[0]?.policy).toBe("isolated");
    expect(mocks.registered[0]?.html).toContain(RENDER_MESSAGE_SOURCE);

    const ev = new MessageEvent("message", {
      data: { source: RENDER_MESSAGE_SOURCE, kind: "open-link", href: "https://example.com/doc" },
    });
    Object.defineProperty(ev, "source", { value: iframe!.contentWindow });
    await act(async () => {
      window.dispatchEvent(ev);
    });
    expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://example.com/doc");
  });
});
