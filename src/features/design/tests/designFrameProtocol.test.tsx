/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tauriMocks = vi.hoisted(() => {
  let seq = 0;
  let windowsStyle = false;
  const registered: Array<{ id: string; html: string; policy: string }> = [];
  const invoke = vi.fn(async (cmd: string, args?: { html?: string; policy?: string }) => {
    if (cmd === "design_frame_register") {
      const id = String(++seq).padStart(64, "0");
      registered.push({ id, html: args?.html ?? "", policy: args?.policy ?? "" });
      return id;
    }
    throw new Error(`comando inesperado: ${cmd}`);
  });
  const convertFileSrc = vi.fn((path: string, protocol = "asset") =>
    windowsStyle
      ? `http://${protocol}.localhost/${encodeURIComponent(path)}`
      : `${protocol}://localhost/${encodeURIComponent(path)}`,
  );
  const isTauri = vi.fn(() => true);
  return {
    invoke,
    convertFileSrc,
    isTauri,
    registered,
    reset() {
      seq = 0;
      windowsStyle = false;
      registered.length = 0;
      invoke.mockClear();
      convertFileSrc.mockClear();
      isTauri.mockReturnValue(true);
    },
    setWindowsStyle(value: boolean) {
      windowsStyle = value;
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  convertFileSrc: tauriMocks.convertFileSrc,
  isTauri: tauriMocks.isTauri,
}));

const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));

import { DESIGN_SANDBOX } from "@/features/canvas/design/srcdoc";
import { clearDesignFrameCache, DESIGN_FRAME_SCHEME } from "@/shared/ipc/designFrame";

import { ArtboardFrame, type FrameHandlers, type StudioBoard } from "../ArtboardFrame";
import { FocusedView } from "../DesignStudio";
import { FRAME_MSG, HOST_MSG } from "../frameBridge";

const handlers: FrameHandlers = {
  onTitleDown: vi.fn(),
  onGripDown: vi.fn(),
  onRenameStart: vi.fn(),
  onRename: vi.fn(),
  onContext: vi.fn(),
  onExpand: vi.fn(),
  onPlay: vi.fn(),
  onFrameLoad: vi.fn(),
  onForceLoad: vi.fn(),
  register: vi.fn(),
};

const page = (head: string, body: string) =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const RED_HEAD = "<style>p{color:red}</style>";
const BLUE_HEAD = "<style>p{color:blue}</style>";

const makeBoard = (html: string): StudioBoard => ({
  id: "b1",
  title: "Prancheta",
  x: 0,
  y: 0,
  w: 320,
  h: 200,
  html,
  radius: 0,
  version: 1,
});

let host: HTMLDivElement;
let root: Root;

async function renderArtboard(html: string) {
  await act(async () => {
    root.render(
      <ArtboardFrame
        board={makeBoard(html)}
        live
        selected={false}
        grips={false}
        passThrough={false}
        agent={null}
        renaming={false}
        playing={false}
        guides={false}
        h={handlers}
      />,
    );
  });
}

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

describe("ArtboardFrame e FocusedView com protocolo ags-design", () => {
  it("usa src com o scheme ags-design em vez de srcdoc e mantém sandbox só allow-scripts", async () => {
    await renderArtboard(page(RED_HEAD, "<button onclick=\"this.textContent='clicado'\">ir</button>"));

    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe(DESIGN_SANDBOX);
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe?.hasAttribute("srcdoc")).toBe(false);
    expect(iframe?.getAttribute("src")).toMatch(new RegExp(`^${DESIGN_FRAME_SCHEME}://localhost/[0-9a-f]{64}$`));
    expect(tauriMocks.registered).toHaveLength(1);
    expect(tauriMocks.registered[0]?.policy).toBe("design");
    expect(tauriMocks.registered[0]?.html).toContain(FRAME_MSG);
    expect(tauriMocks.registered[0]?.html).toContain("onclick");
  });

  it("no Windows usa o formato http://ags-design.localhost/<id>", async () => {
    tauriMocks.setWindowsStyle(true);
    await renderArtboard(page(RED_HEAD, "<p>win</p>"));

    const iframe = host.querySelector("iframe");
    expect(iframe?.hasAttribute("srcdoc")).toBe(false);
    expect(iframe?.getAttribute("src")).toMatch(/^http:\/\/ags-design\.localhost\/[0-9a-f]{64}$/);
  });

  it("mudança só no corpo mantém o mesmo src e envia replaceHtml por postMessage; mudança no head troca o src", async () => {
    await renderArtboard(page(RED_HEAD, "<p>um</p>"));
    const iframe = host.querySelector("iframe")!;
    const firstSrc = iframe.getAttribute("src");
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");

    await renderArtboard(page(RED_HEAD, "<p>dois</p>"));
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(firstSrc);
    expect(tauriMocks.registered).toHaveLength(1);
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: HOST_MSG, kind: "replaceHtml", html: page(RED_HEAD, "<p>dois</p>") }),
      "*",
    );

    await renderArtboard(page(BLUE_HEAD, "<p>dois</p>"));
    const secondSrc = host.querySelector("iframe")?.getAttribute("src");
    expect(secondSrc).not.toBe(firstSrc);
    expect(tauriMocks.registered).toHaveLength(2);
    expect(tauriMocks.registered[1]?.html).toContain("color:blue");
  });

  it("FocusedView (Play) usa src com ags-design em vez de srcdoc e mantém sandbox allow-scripts", async () => {
    const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    try {
      const register = vi.fn();
      await act(async () => {
        root.render(<FocusedView board={makeBoard("<button onclick=\"1\">play</button>")} fit="fit" register={register} />);
      });
      const iframe = host.querySelector("iframe");
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(iframe?.hasAttribute("srcdoc")).toBe(false);
      expect(iframe?.getAttribute("src")).toMatch(/^ags-design:\/\/localhost\/[0-9a-f]{64}$/);
      expect(tauriMocks.registered[0]?.policy).toBe("design");
    } finally {
      if (origWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origWidth);
      if (origHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origHeight);
    }
  });
});
