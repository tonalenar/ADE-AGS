// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { BrowserMiniControls } from "../BrowserMiniControls";
import { setChatBrowser, setChatBrowserFloatRect, toggleChatBrowserFloating, useChatStore } from "@/features/chat/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useChatStore.setState({ browser: null, browserFloating: false, browserFloatRect: null, panel: null, panelMaximized: false });
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<BrowserMiniControls />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function startMini() {
  const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { activate: false });
  setChatBrowser({ viewId, rect: { left: 20, top: 30, width: 500, height: 360 } });
  toggleChatBrowserFloating();
  return viewId;
}

function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Botão ausente: ${label}`);
  act(() => button.click());
}

describe("controles da miniatura do navegador", () => {
  it("a miniatura retraída abre o navegador no painel lateral", () => {
    const viewId = startMini();
    expect(useChatStore.getState().browserFloating).toBe(true);
    expect(useChatStore.getState().panel).toBeNull();
    expect(useChatStore.getState().browser?.viewId).toBe(viewId);
    setChatBrowserFloatRect({ left: 200, top: 300, width: 480, height: 320 });
    expect(useChatStore.getState().browserFloatRect).toEqual({ left: 200, top: 300, width: 480, height: 320 });
    expect(useChatStore.getState().browser?.rect).toEqual({ left: 20, top: 30, width: 500, height: 360 });
    click("browser.mini.openPanel");
    expect(useChatStore.getState().panel).toBe("browser");
    expect(useChatStore.getState().browserFloating).toBe(false);
  });

  it("o botão de janela abre o painel expandido", () => {
    startMini();
    click("browser.mini.openWindow");
    expect(useChatStore.getState().panel).toBe("browser");
    expect(useChatStore.getState().panelMaximized).toBe(true);
  });

  it("fecha só a miniatura e mantém a mesma aba de navegador montada", () => {
    const viewId = startMini();
    click("browser.mini.close");
    expect(useChatStore.getState().browserFloating).toBe(false);
    expect(useChatStore.getState().browser).toBeNull();
    expect(useViewTabsStore.getState().views.some((view) => view.id === viewId)).toBe(true);
  });
});
