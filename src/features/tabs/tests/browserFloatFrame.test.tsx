/** @vitest-environment happy-dom */
import { act } from "react";
// @ts-expect-error flag do React para act() fora do RTL
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot } from "react-dom/client";
import { describe, expect, it, beforeEach } from "vitest";
import { BrowserFloatFrame } from "../ViewTabsHost";
import { setChatBrowser, toggleChatBrowserFloating, useChatStore } from "@/features/chat/store";

function box(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r });
}

describe("anel da miniatura do navegador", () => {
  beforeEach(() => {
    useChatStore.setState({ browser: null, browserFloating: false, browserFloatRect: null, browserFloatPinned: false });
    setChatBrowser({ viewId: "v1", rect: { left: 0, top: 0, width: 500, height: 400 } });
    toggleChatBrowserFloating();
    useChatStore.setState({ browserFloatRect: { left: 500, top: 300, width: 400, height: 300 } });
  });

  it("move pela borda de cima mesmo com o host fora de [data-chat-shell]", () => {
    // O shell e o host das vistas são irmãos, como no app: `closest` não acha o shell a partir do anel.
    const shell = document.createElement("div");
    shell.setAttribute("data-chat-shell", "");
    const main = document.createElement("main");
    shell.appendChild(main);
    document.body.appendChild(shell);
    box(shell, { left: 0, top: 0, width: 1200, height: 900 });
    box(main, { left: 0, top: 0, width: 1200, height: 900 });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<BrowserFloatFrame rect={{ left: 500, top: 300, width: 400, height: 300 }} />));
    const fire = (el: Element, type: string, init: PointerEventInit) => act(() => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })); });
    const top = container.querySelector("[data-float-ring=top]")!;
    fire(top, "pointerdown", { button: 0, pointerId: 1, clientX: 700, clientY: 295 });
    fire(top, "pointermove", { pointerId: 1, clientX: 600, clientY: 245 });
    fire(top, "pointerup", { pointerId: 1, clientX: 600, clientY: 245 });
    expect(useChatStore.getState()).toMatchObject({ browserFloatPinned: true, browserFloatRect: { left: 400, top: 250, width: 400, height: 300 } });

    const corner = container.querySelector("[data-float-ring=se]")!;
    fire(corner, "pointerdown", { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fire(corner, "pointermove", { pointerId: 2, clientX: 50, clientY: 40 });
    fire(corner, "pointerup", { pointerId: 2, clientX: 50, clientY: 40 });
    expect(useChatStore.getState().browserFloatRect).toEqual({ left: 400, top: 250, width: 450, height: 340 });
    act(() => root.unmount());
    container.remove();
    shell.remove();
  });
});
