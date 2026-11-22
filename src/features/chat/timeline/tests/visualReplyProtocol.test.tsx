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
vi.mock("@/shared/ui/ViewModal", () => ({
  ViewModal: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
}));

import { clearDesignFrameCache } from "@/shared/ipc/designFrame";

import { VISUAL_REPLY_SOURCE, VisualReplyPreview } from "../VisualReplyPreview";

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

describe("VisualReplyPreview com protocolo ags-design", () => {
  it("serve a prévia por ags-design (política isolated) sem srcdoc e restaura o mesmo src ao navegar para fora", async () => {
    await act(async () => {
      root.render(<VisualReplyPreview html="<p>prévia</p>" onClose={() => {}} />);
    });

    const original = host.querySelector("iframe");
    expect(original).not.toBeNull();
    expect(original?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(original?.hasAttribute("srcdoc")).toBe(false);
    const url = original?.getAttribute("src");
    expect(url).toMatch(/^ags-design:\/\/localhost\/[0-9a-f]{64}$/);
    expect(tauriMocks.registered).toHaveLength(1);
    expect(tauriMocks.registered[0]?.policy).toBe("isolated");

    act(() => {
      original!.dispatchEvent(new Event("load"));
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: VISUAL_REPLY_SOURCE, kind: "navigate-away" },
          source: original!.contentWindow,
        }),
      );
    });

    const restored = host.querySelector("iframe");
    expect(restored).not.toBeNull();
    expect(restored).not.toBe(original);
    expect(restored?.getAttribute("src")).toBe(url);
    expect(restored?.hasAttribute("srcdoc")).toBe(false);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });
});
