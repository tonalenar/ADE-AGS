// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { BrowserFloatGrip } from "../BrowserFloatGrip";
import { useChatStore } from "@/features/chat/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useChatStore.setState({ browser: null, browserFloating: false, browserMiniHover: {} });
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("superfície nativa do navegador", () => {
  it("botao_do_pip_responde_sem_hover_previo", () => {
    useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { id: "browser-1", activate: false });
    useChatStore.setState({ browser: { viewId: "browser-1", rect: { left: 10, top: 10, width: 400, height: 300 } }, browserFloating: true });
    act(() => root.render(<BrowserFloatGrip viewId="browser-1" />));

    // O buraco do grip existe antes de qualquer hover: é ele que deixa o clique chegar ao botão.
    const grip = host.querySelector<HTMLElement>("[data-browser-mini-controls]");
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="browser.mini.openPanel"]');
    expect(grip?.hasAttribute("data-over-webview")).toBe(true);
    expect(useChatStore.getState().browserMiniHover["browser-1"]).toBeUndefined();
    if (!button) throw new Error("Botão de abrir painel ausente");
    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });

    expect(useChatStore.getState().panel).toBe("browser");
  });
});
