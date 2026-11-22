/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const t = vi.hoisted(() => (key: string) => key);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("@/features/canvas/design/designApi", () => ({
  designApi: { storageGet: vi.fn(async () => ({ local: {}, session: {} })), storageSet: vi.fn(), storageClear: vi.fn() },
}));

import { recordFrameError, resetFrameErrors } from "@/features/canvas/design/artboardStore";

import { FocusedView } from "../FocusedView";
import { HOST_MSG } from "../frameBridge";

const board = { id: "foco-1", title: "Entrada", x: 0, y: 0, w: 1440, h: 900, html: "<p>oi</p>", radius: 0, version: 1 };

let host: HTMLDivElement;
let root: Root;
const realWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const realHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

beforeAll(() => {
  // A área do foco precisa de medida: o happy-dom não faz layout, então a janela mede 1200 x 800.
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
});

afterAll(() => {
  if (realWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", realWidth);
  if (realHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", realHeight);
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  resetFrameErrors(board.id);
});

async function renderFocus(width: number | null = null) {
  await act(async () => {
    root.render(<FocusedView board={board} fit="fit" width={width} register={() => {}} />);
  });
  await act(async () => {});
}

describe("tela cheia de uma prancheta", () => {
  it("no foco o Play fica ligado: a prancheta recebe o modo play ao carregar", async () => {
    await renderFocus();
    const frame = host.querySelector("iframe");
    expect(frame?.getAttribute("data-artboard-id")).toBe(board.id);
    const post = vi.spyOn(frame!.contentWindow!, "postMessage");
    await act(async () => { frame!.dispatchEvent(new Event("load")); });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: HOST_MSG, kind: "mode", mode: "play" }), "*");
  });

  it("o celular de 390 px redimensiona o frame", async () => {
    await renderFocus(390);
    const frame = host.querySelector("iframe");
    expect((frame!.parentElement as HTMLElement).style.width).toBe("390px");
  });

  it("um erro de script aparece como aviso discreto no foco, com o último erro no tooltip", async () => {
    await renderFocus();
    // O erro chega depois que o documento existe (o boot manda pela ponte, como em uso real).
    await act(async () => { recordFrameError(board.id, { message: "ReferenceError: x is not defined", line: 2 }); });
    const badge = host.querySelector("[role='status']");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("title")).toContain("design.studio.frameErrorHint");
  });
});
