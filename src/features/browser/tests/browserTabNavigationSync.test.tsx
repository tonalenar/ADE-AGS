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

vi.mock("../realBrowser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../realBrowser")>()),
  realBrowserOpen: (...args: unknown[]) => openSpy(...args),
  realBrowserPlace: (...args: unknown[]) => placeSpy(...args),
  realBrowserClose: (...args: unknown[]) => closeSpy(...args),
  realBrowserNavigate: (...args: unknown[]) => navigateSpy(...args),
  realBrowserEmulate: (...args: unknown[]) => emulateSpy(...args),
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
  navigateSpy.mockClear();
  emulateSpy.mockClear();
  openSpy.mockClear();
  placeSpy.mockClear();
  closeSpy.mockClear();
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

function renderView(viewId: string) {
  function Wrapper() {
    const current = useViewTabsStore((s) => s.views.find((v): v is BrowserView => v.id === viewId && v.kind === "browser"));
    if (!current) return null;
    return <BrowserTab view={current} active={true} />;
  }
  act(() => root.render(<Wrapper />));
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
});
