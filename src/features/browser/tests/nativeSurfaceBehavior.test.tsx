// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { BrowserFloatGrip } from "../BrowserFloatGrip";
import { publishMeasuredChatBrowser, subscribeToMeasuredChatBrowser } from "@/features/chat/browserMeasurement";
import { useChatStore } from "@/features/chat/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { usePortalViewLifetime } from "@/features/canvas/portalLifetime";

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

  it("grip_do_pip_usa_hit_sem_hover_e_abre_buraco_visual_ao_exibir_controles", () => {
    act(() => root.render(<BrowserFloatGrip viewId="browser-1" />));
    const grip = host.querySelector<HTMLElement>("[data-browser-mini-controls]");
    const button = host.querySelector<HTMLButtonElement>("button");
    expect(grip?.getAttribute("data-over-webview")).toBe("hit");

    act(() => { grip?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
    expect(grip?.getAttribute("data-over-webview")).toBe("");

    act(() => { grip?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
    expect(grip?.getAttribute("data-over-webview")).toBe("hit");

    act(() => { useChatStore.setState({ browserMiniHover: { "browser-1": true } }); });
    expect(grip?.getAttribute("data-over-webview")).toBe("");

    act(() => { useChatStore.setState({ browserMiniHover: {} }); });
    expect(grip?.getAttribute("data-over-webview")).toBe("hit");

    act(() => { button?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(grip?.getAttribute("data-over-webview")).toBe("");

    act(() => { button?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })); });
    expect(grip?.getAttribute("data-over-webview")).toBe("hit");
  });

  it("miniatura_do_agente_usa_medida_real", () => {
    // Antes de o slot medir, não há origem: a miniatura não abre com um retângulo inventado.
    const measured = vi.fn();
    const unsubscribe = subscribeToMeasuredChatBrowser("browser-1", measured);
    expect(measured).not.toHaveBeenCalled();

    act(() => useChatStore.setState({ browser: { viewId: "browser-1", rect: { left: 3, top: 4, width: 420, height: 310 } } }));
    expect(measured).toHaveBeenCalledWith({ viewId: "browser-1", rect: { left: 3, top: 4, width: 420, height: 310 } });
    unsubscribe();
  });

  it("slot_zero_nao_zera_chat_browser", () => {
    // Um slot que mede zero (painel recolhido, troca de aba) não apaga a última medida válida.
    useChatStore.setState({ browser: { viewId: "browser-1", rect: { left: 3, top: 4, width: 420, height: 310 } } });
    publishMeasuredChatBrowser("browser-1", { left: 0, top: 0, width: 0, height: 0 });
    expect(useChatStore.getState().browser).toEqual({ viewId: "browser-1", rect: { left: 3, top: 4, width: 420, height: 310 } });
    publishMeasuredChatBrowser("browser-1", { left: 8, top: 9, width: 500, height: 350 });
    expect(useChatStore.getState().browser).toEqual({ viewId: "browser-1", rect: { left: 8, top: 9, width: 500, height: 350 } });
  });

  it("cwd_muda_sem_recriar_portal", () => {
    // Trocar a pasta de referência não recria a vista do Portal: ela é criada uma vez e só sai ao desmontar. A pasta
    // da vista existente é atualizada.
    const ensure = vi.fn();
    const drop = vi.fn();
    const setCwd = vi.fn();
    const mount = (cwd: string) => act(() => root.render(<PortalLifetime id="portal-1" cwd={cwd} ensure={ensure} drop={drop} setCwd={setCwd} />));
    mount("/workspace/a");
    mount("/workspace/b");

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith("portal-1", "/workspace/a");
    expect(drop).not.toHaveBeenCalled();
    expect(setCwd).toHaveBeenCalledTimes(1);
    expect(setCwd).toHaveBeenCalledWith("portal-1", "/workspace/b");
  });
});

function PortalLifetime({ id, cwd, ensure, drop, setCwd }: { id: string; cwd: string; ensure: (id: string, cwd: string) => void; drop: (id: string) => void; setCwd: (id: string, cwd: string) => void }) {
  usePortalViewLifetime(id, cwd, ensure, drop, setCwd);
  return null;
}
