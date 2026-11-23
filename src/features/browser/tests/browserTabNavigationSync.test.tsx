// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();

vi.mock("@/app/platform", () => ({ DESKTOP_OS: "macos" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Handler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    return Promise.resolve(() => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler)));
  },
}));
vi.mock("../ipc", () => ({
  previewDetectServers: () => Promise.resolve([]),
  previewResolve: vi.fn(),
  previewSaveCapture: vi.fn(),
  previewSetRecording: () => Promise.resolve(),
}));

const navigateSpy = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
const emulateSpy = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
const openSpy = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
const placeSpy = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
const closeSpy = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
const postSpy = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
let capturedHost: import("../agentBridge").BrowserHost | null = null;

vi.mock("../agentBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agentBridge")>();
  return {
    ...actual,
    registerBrowserHost: (h: import("../agentBridge").BrowserHost) => {
      capturedHost = h;
      return actual.registerBrowserHost(h);
    },
  };
});

vi.mock("../realBrowser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../realBrowser")>()),
  realBrowserOpen: (...args: unknown[]) => openSpy(...args),
  realBrowserPlace: (...args: unknown[]) => placeSpy(...args),
  realBrowserClose: (...args: unknown[]) => closeSpy(...args),
  realBrowserNavigate: (...args: unknown[]) => navigateSpy(...args),
  realBrowserEmulate: (...args: unknown[]) => emulateSpy(...args),
  realBrowserPost: (...args: unknown[]) => postSpy(...args),
}));

import { BrowserTab } from "../BrowserTab";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import type { BrowserView } from "@/features/tabs/viewTabs";

let host: HTMLDivElement;
let root: Root;

function emit(name: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(name) ?? []) handler({ payload });
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  }
  if (!("IntersectionObserver" in globalThis)) {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    });
  }
  if (!("checkVisibility" in HTMLElement.prototype)) {
    Object.assign(HTMLElement.prototype, { checkVisibility: () => true });
  }
  handlers.clear();
  navigateSpy.mockReset();
  navigateSpy.mockImplementation(() => Promise.resolve());
  emulateSpy.mockClear();
  openSpy.mockClear();
  placeSpy.mockClear();
  closeSpy.mockClear();
  postSpy.mockClear();
  capturedHost = null;
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [], portalViews: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function ViewWrapper({ viewId, active, surfaceActive, floatingPreview }: {
  viewId: string;
  active: boolean;
  surfaceActive?: boolean;
  floatingPreview?: boolean;
}) {
  const current = useViewTabsStore((s) => s.views.find((v): v is BrowserView => v.id === viewId && v.kind === "browser"));
  if (!current) return null;
  return <BrowserTab view={current} active={active} surfaceActive={surfaceActive} floatingPreview={floatingPreview} />;
}

function renderView(viewId: string, arg: boolean | { active?: boolean; surfaceActive?: boolean; floatingPreview?: boolean } = {}) {
  const props = typeof arg === "boolean" ? { active: arg } : arg;
  act(() => root.render(
    <ViewWrapper viewId={viewId} active={props.active ?? true} surfaceActive={props.surfaceActive} floatingPreview={props.floatingPreview} />,
  ));
}

describe("BrowserTab: sincronia de URL nativa e emulação inicial", () => {
  it("onUrl_atualiza_view_sem_disparar_realBrowserNavigate_em_cascata", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);
    navigateSpy.mockClear();

    // O CEF informa redirect / navegação interna pela página: não pode voltar como `realBrowserNavigate`.
    emit("real-browser-url", { id, url: "https://example.com/dashboard" });
    await act(async () => undefined);

    const view = useViewTabsStore.getState().views.find((v) => v.id === id) as BrowserView;
    expect(view.url).toBe("https://example.com/dashboard");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("onUrl_ignora_chrome_error_sem_sobrescrever_url_nem_mostrar_erro", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);
    navigateSpy.mockClear();

    emit("real-browser-url", { id, url: "chrome-error://chromewebdata/" });
    await act(async () => undefined);

    const view = useViewTabsStore.getState().views.find((v) => v.id === id) as BrowserView;
    expect(view.url).toBe("https://example.com/");
    expect(view.title).not.toBe("chromewebdata");
    expect(host.textContent).not.toContain("browser.invalidUrl");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("abertura_desktop_nao_chama_realBrowserEmulate_desnecessariamente", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);

    // Primeira URL deixa `realReady = true`, mas o modo inicial já é mesa (`null|false`).
    emit("real-browser-url", { id, url: "https://example.com/" });
    await act(async () => undefined);
    expect(emulateSpy).not.toHaveBeenCalled();

    // Trocar explicitamente para iOS dispara a emulação.
    act(() => {
      useViewTabsStore.getState().updateView(id, { mobile: "ios", viewport: { width: 390, height: 844 } });
    });
    await act(async () => undefined);
    expect(emulateSpy).toHaveBeenCalledTimes(1);
    expect(emulateSpy.mock.calls[0]?.[1]).toBe("ios");
  });

  it("abertura_com_url_dispara_apenas_uma_navegacao_nativa", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);

    // RealBrowserView já abre a URL inicial em `realBrowserOpen`; BrowserTab não deve disparar segundo `realBrowserNavigate`.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[1]).toBe("https://example.com/");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("redirect_durante_realBrowserNavigate_nao_regride_url_apos_await", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);
    navigateSpy.mockClear();

    let resolveNavigate: (() => void) | null = null;
    navigateSpy.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveNavigate = resolve;
    }));

    // Simula navegação para URL que redireciona enquanto `realBrowserNavigate` ainda está pendente.
    act(() => {
      useViewTabsStore.getState().updateView(id, { url: "https://example.com/start" });
    });
    await act(async () => undefined);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith(id, "https://example.com/start");

    // O CEF entrega o redirect antes do `await realBrowserNavigate` resolver.
    emit("real-browser-url", { id, url: "https://example.com/login" });
    await act(async () => undefined);

    // Quando o `await` termina, a URL não pode regredir para `/start` nem disparar outra navegação.
    await act(async () => { resolveNavigate?.(); });
    await act(async () => undefined);

    const view = useViewTabsStore.getState().views.find((v) => v.id === id) as BrowserView;
    expect(view.url).toBe("https://example.com/login");
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it("onTitle_igual_nao_regrava_viewStore", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);

    let storeWrites = 0;
    const unsubscribe = useViewTabsStore.subscribe(() => { storeWrites += 1; });
    try {
      emit("real-browser-title", { id, title: "Painel" });
      expect(storeWrites).toBe(1);

      emit("real-browser-title", { id, title: "Painel" });
      emit("real-browser-title", { id, title: "Painel" });
      expect(storeWrites).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("motor_nativo_envia_view_hidden_e_view_shown_para_o_cursor", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: false });
    renderView(id, { active: false, surfaceActive: false });
    await act(async () => undefined);
    postSpy.mockClear();

    // Assim que a vista nativa sinaliza pronta ou carrega um novo documento, recebe `view:hidden` se oculta.
    emit("real-browser-url", { id, url: "https://example.com/" });
    await act(async () => undefined);
    expect(postSpy).toHaveBeenCalledWith(id, { source: "ade-ags", type: "view:hidden" });

    postSpy.mockClear();
    emit("real-browser-page", { id, message: { source: "ags-preview", type: "page:ready", payload: { doc: "d1", url: "https://example.com/" } } });
    await act(async () => undefined);
    expect(postSpy).toHaveBeenCalledWith(id, { source: "ade-ags", type: "view:hidden" });

    // Quando volta a ficar visível, envia `view:shown`.
    postSpy.mockClear();
    renderView(id, { active: true, surfaceActive: true });
    await act(async () => undefined);
    expect(postSpy).toHaveBeenCalledWith(id, { source: "ade-ags", type: "view:shown" });
  });
});

const types = () => postSpy.mock.calls.map((c) => (c[1] as { type: string }).type);

describe("BrowserTab: o motor nativo também avisa se a aba está à vista", () => {
  it("aba escondida manda view:hidden ao CEF (sem isso o cursor do agente anima 330 ms para ninguém)", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: false });
    renderView(id, false);
    await act(async () => undefined);
    // Desde o #427 o aviso sai quando a página fica pronta (realReady / page:ready).
    emit("real-browser-page", { id, message: { source: "ags-preview", type: "page:ready", payload: { url: "https://example.com/", doc: "d0" } } });
    await act(async () => undefined);
    expect(types()).toContain("view:hidden");
    expect(types()).not.toContain("view:shown");
  });

  it("aba ativa manda view:shown", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id, true);
    await act(async () => undefined);
    // Desde o #427 o aviso sai quando a página fica pronta (realReady / page:ready).
    emit("real-browser-page", { id, message: { source: "ags-preview", type: "page:ready", payload: { url: "https://example.com/", doc: "d0" } } });
    await act(async () => undefined);
    expect(types()).toContain("view:shown");
  });

  it("documento novo de uma aba escondida avisa view:hidden de novo (o runtime nasce «à vista»)", async () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: false });
    renderView(id, false);
    await act(async () => undefined);
    postSpy.mockClear();
    emit("real-browser-page", { id, message: { source: "ags-preview", type: "page:ready", payload: { url: "https://example.com/", doc: "d1" } } });
    await act(async () => undefined);
    expect(types()).toContain("view:hidden");
  });
});

describe("BrowserTab: waitForLoad também acaba com o load do CEF (página de erro ou sem runtime)", () => {
  afterEach(() => vi.useRealTimers());

  it("o CEF termina a carga e o runtime nunca avisa: a espera resolve logo depois da tolerância, não no teto", async () => {
    vi.useFakeTimers();
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);
    const mark = capturedHost!.loadCount();
    await act(async () => { await capturedHost!.navigate("https://example.com/erro"); });
    const waiting = capturedHost!.waitForLoad(mark, 20_000);
    let result: boolean | null = null;
    void waiting.then((r) => { result = r; });

    emit("real-browser-load", { id, loading: true });
    emit("real-browser-load", { id, loading: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(result).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(result).toBe(true);
  });

  it("uma carga do CEF que começou ANTES do pedido não destrava a espera da navegação nova", async () => {
    vi.useFakeTimers();
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com/", { activate: true });
    renderView(id);
    await act(async () => undefined);
    emit("real-browser-load", { id, loading: true });
    const mark = capturedHost!.loadCount();
    await act(async () => { await capturedHost!.navigate("https://example.com/b"); });
    const waiting = capturedHost!.waitForLoad(mark, 5_000);
    let result: boolean | null = null;
    void waiting.then((r) => { result = r; });
    emit("real-browser-load", { id, loading: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(result).toBe(false);
  });
});
