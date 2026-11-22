/** @vitest-environment happy-dom */
import { act, createElement } from "react";
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
    // O storage da prancheta (paridade com Artifacts) carrega antes do iframe: começa vazio.
    if (cmd === "design_storage_get") return null;
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

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("neogestify-ui-components", () => ({
  Button: ({ children, onClick, disabled, className }: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) =>
    createElement("button", { onClick, disabled, className }, children),
  CloseIcon: () => createElement("span"),
}));
vi.mock("@/shared/ui/PopupSelect", () => ({
  PopupSelect: ({ children }: { children?: React.ReactNode }) => createElement("select", null, children),
}));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: vi.fn() }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: (sel: (s: { tabs: never[] }) => unknown) => sel({ tabs: [] }) }));
vi.mock("@/features/missions/groups", () => ({ useMissionIndex: () => new Map() }));

import { clearDesignFrameCache } from "@/shared/ipc/designFrame";

import { BoardCard } from "../BoardCard";
import { DesignPanel } from "../DesignPanel";
import type { Artboard, DesignDetail } from "../designApi";
import { CHOOSER_SCRIPT, DESIGN_SANDBOX, PICKER_SCRIPT, PICK_MESSAGE } from "../srcdoc";

const BOARD: Artboard = {
  id: "a1",
  pageId: "p1",
  title: "Tela 1",
  html: "<button onclick=\"this.textContent='ok'\">Botão</button>",
  width: 360,
  height: 240,
  x: 0,
  y: 0,
  version: 1,
  status: "draft",
};

const DETAIL: DesignDetail = {
  design: { id: "d1", workspace: "/tmp/proj", missionId: null, ownerTabId: null, title: "App", status: "draft" },
  pages: [{ id: "p1", designId: "d1", name: "Página 1", order: 0 }],
  artboards: [BOARD],
  comments: [],
  versions: { a1: [{ version: 1, html: BOARD.html, title: BOARD.title }] },
  notes: [],
  shapes: [],
};

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

describe("BoardCard e DesignPanel com protocolo ags-design", () => {
  it("BoardCard usa src com ags-design em vez de srcdoc, mantém sandbox allow-scripts e aceita postMessage", async () => {
    const onChoose = vi.fn();
    await act(async () => {
      root.render(
        <BoardCard
          board={BOARD}
          active={false}
          comments={0}
          onEdit={vi.fn()}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onChoose={onChoose}
        />,
      );
    });

    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe(DESIGN_SANDBOX);
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.hasAttribute("srcdoc")).toBe(false);
    expect(iframe?.getAttribute("src")).toMatch(/^ags-design:\/\/localhost\/[0-9a-f]{64}$/);
    expect(tauriMocks.registered[0]?.policy).toBe("design");
    expect(tauriMocks.registered[0]?.html).toContain(CHOOSER_SCRIPT);

    // Liga modo Escolher e valida que o postMessage do iframe continua sendo aceito.
    const chooseBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "canvas.design.choose");
    await act(async () => {
      chooseBtn!.click();
    });
    const ev = new MessageEvent("message", { data: { type: PICK_MESSAGE, selector: "button:nth-of-type(1)", text: "Botão" } });
    Object.defineProperty(ev, "source", { value: iframe!.contentWindow });
    await act(async () => {
      window.dispatchEvent(ev);
    });
    expect(onChoose).toHaveBeenCalledWith({ selector: "button:nth-of-type(1)", text: "Botão" });
  });

  it("BoardCard fora da vista (live=false) não registra nem monta iframe", async () => {
    await act(async () => {
      root.render(
        <BoardCard
          board={BOARD}
          active={false}
          comments={0}
          live={false}
          onEdit={vi.fn()}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onChoose={vi.fn()}
        />,
      );
    });
    expect(host.querySelector("iframe")).toBeNull();
    expect(tauriMocks.registered).toHaveLength(0);
  });

  it("DesignPanel (EditPane) usa src com ags-design, sem srcdoc, com PICKER_SCRIPT e sandbox allow-scripts", async () => {
    await act(async () => {
      root.render(
        <DesignPanel
          details={[DETAIL]}
          reload={vi.fn()}
          initial={{ designId: "d1", editBoardId: "a1" }}
          onClose={vi.fn()}
        />,
      );
    });

    const iframes = [...host.querySelectorAll("iframe")];
    expect(iframes.length).toBeGreaterThanOrEqual(2);
    for (const iframe of iframes) {
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
      expect(iframe.hasAttribute("srcdoc")).toBe(false);
      expect(iframe.getAttribute("src")).toMatch(/^ags-design:\/\/localhost\/[0-9a-f]{64}$/);
    }
    expect(tauriMocks.registered.some((r) => r.html.includes(PICKER_SCRIPT))).toBe(true);
  });
});
