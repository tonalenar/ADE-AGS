// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResizeHandle } from "../RightPanel";
import { useChatStore } from "../store";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let root: Root;
let host: HTMLDivElement;
let mount: HTMLDivElement;
let aside: HTMLElement;
let handle: HTMLElement;
let frameCallback: FrameRequestCallback | null;
const panelWidthRenders: number[] = [];

function PanelWidthProbe() {
  const width = useChatStore((state) => state.panelWidth);
  panelWidthRenders.push(width);
  return null;
}

function rect(left: number, right: number) {
  return { left, right, top: 0, bottom: 800, width: right - left, height: 800, x: left, y: 0, toJSON: () => ({}) };
}

const fire = (type: string, clientX: number, button = 0) => act(() => {
  handle.dispatchEvent(new PointerEvent(type, { bubbles: true, button, pointerId: 1, clientX, clientY: 10 }));
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  mount = document.createElement("div");
  aside = document.createElement("aside");
  const main = document.createElement("main");
  main.getBoundingClientRect = () => rect(0, 860) as DOMRect;
  aside.getBoundingClientRect = () => rect(860, 1400) as DOMRect;
  host.append(main, aside);
  aside.append(mount);
  root = createRoot(mount);
  aside.style.setProperty("--chat-panel-width", "540px");
  useChatStore.setState({ panelWidth: 540 });
  panelWidthRenders.length = 0;
  const panelRef = createRef<HTMLElement>();
  panelRef.current = aside;
  frameCallback = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frameCallback = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  act(() => root.render(<><ResizeHandle panelRef={panelRef} /><PanelWidthProbe /></>));
  handle = aside.querySelector('[role="separator"]')!;
  Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("arrasto do divisor do painel", () => {
  it("não publica cada movimento no estado; aplica o último tamanho no quadro e confirma uma vez no fim", () => {
    const updates: number[] = [];
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.panelWidth !== previous.panelWidth) updates.push(state.panelWidth);
    });

    fire("pointerdown", 860);
    fire("pointermove", 800);
    fire("pointermove", 760);

    expect(updates).toEqual([]);
    expect(panelWidthRenders).toEqual([540]);
    expect(useChatStore.getState().panelWidth).toBe(540);
    expect(aside.style.getPropertyValue("--chat-panel-width")).toBe("540px");

    act(() => frameCallback?.(0));
    expect(aside.style.getPropertyValue("--chat-panel-width")).toBe("640px");

    fire("pointerup", 760);
    expect(updates).toEqual([640]);
    expect(panelWidthRenders).toEqual([540, 640]);
    expect(localStorage.getItem("ags.chat.panelWidth")).toBe("640");
    unsubscribe();
  });
});
