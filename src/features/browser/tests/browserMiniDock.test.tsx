// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { BrowserMiniDock } from "../BrowserMiniControls";
import { floatAspectRatioOf, registerBrowserDeviceActions } from "../deviceMode";
import { FILL_VIEWPORT } from "../viewport";
import { setChatBrowser, toggleChatBrowserFloating, useChatStore } from "@/features/chat/store";
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function setupView(opts: { viewport?: { width: number; height: number } | null; mobile?: "ios" | "android" | null } = {}) {
  const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { activate: false });
  useViewTabsStore.getState().updateView(viewId, {
    viewport: opts.viewport ?? { width: 390, height: 844 },
    mobile: opts.mobile === undefined ? "ios" : opts.mobile,
    touch: (opts.mobile === undefined ? "ios" : opts.mobile) !== null,
  });
  setChatBrowser({ viewId, rect: { left: 20, top: 30, width: 500, height: 700 } });
  toggleChatBrowserFloating();
  act(() => root.render(<BrowserMiniDock viewId={viewId} visible />));
  return viewId;
}

function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Botão ausente: ${label}`);
  act(() => button.click());
  return button;
}

function currentView(viewId: string) {
  const view = useViewTabsStore.getState().views.find((v) => v.id === viewId);
  if (!view || view.kind !== "browser") throw new Error("Vista ausente");
  return view;
}

describe("dock flutuante da miniatura no modo aparelho", () => {
  it("alterna plataforma (iPhone | Android | Desktop), formato (Aparelho | Completo), gira e expande de volta", () => {
    const viewId = setupView();

    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBe(7);
    expect(buttons.every((b) => !b.hasAttribute("title"))).toBe(true);
    expect(floatAspectRatioOf(currentView(viewId).viewport)).toBeCloseTo(390 / 844, 5);

    // iPhone -> Android
    click("browser.viewport.android");
    expect(currentView(viewId)).toMatchObject({ mobile: "android", viewport: { width: 412, height: 915 } });

    // Girar em Android
    click("browser.viewport.rotate");
    expect(currentView(viewId).viewport).toEqual({ width: 915, height: 412 });

    // Android -> Desktop (sai de telefone para desktop 1440×900)
    click("browser.viewport.desktop");
    expect(currentView(viewId)).toMatchObject({ mobile: null, viewport: { width: 1440, height: 900 } });

    // Desktop -> Completo
    click("browser.viewport.full");
    expect(currentView(viewId).viewport).toEqual(FILL_VIEWPORT);
    expect(floatAspectRatioOf(currentView(viewId).viewport)).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="browser.viewport.rotate"]')!.disabled).toBe(true);

    // Completo -> iPhone (mantém modo Completo com emulação iOS)
    click("browser.viewport.ios");
    expect(currentView(viewId)).toMatchObject({ mobile: "ios", viewport: null });

    // Completo -> Aparelho (volta ao quadro do iPhone)
    click("browser.viewport.frame");
    expect(currentView(viewId)).toMatchObject({ mobile: "ios", viewport: { width: 390, height: 844 } });
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="browser.viewport.rotate"]')!.disabled).toBe(false);

    // Expandir de volta ao painel lateral sem perder a vista
    click("browser.mini.openPanel");
    expect(useChatStore.getState().panel).toBe("browser");
    expect(useChatStore.getState().browserFloating).toBe(false);
    expect(currentView(viewId).id).toBe(viewId);
  });

  it("reaproveita as ações registradas pelo BrowserTab quando montado", () => {
    const viewId = setupView();
    const choosePlatform = vi.fn();
    const chooseFull = vi.fn();
    const rotate = vi.fn();
    const unregister = registerBrowserDeviceActions(viewId, { choosePlatform, chooseFull, rotate });

    try {
      click("browser.viewport.android");
      click("browser.viewport.full");
      click("browser.viewport.rotate");
      expect(choosePlatform).toHaveBeenCalledWith("android");
      expect(chooseFull).toHaveBeenCalledWith(true);
      expect(rotate).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
