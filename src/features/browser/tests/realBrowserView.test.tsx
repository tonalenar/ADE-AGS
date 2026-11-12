// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Handler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    return Promise.resolve(() => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler)));
  },
}));

const opened: string[] = [];
const closed: string[] = [];
vi.mock("../realBrowser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../realBrowser")>()),
  realBrowserOpen: (id: string) => { opened.push(id); return Promise.resolve(); },
  realBrowserPlace: () => Promise.resolve(),
  realBrowserClose: (id: string) => { closed.push(id); return Promise.resolve(); },
}));

import { RealBrowserView } from "../RealBrowserView";
import { useChatStore } from "@/features/chat/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

let host: HTMLDivElement;
let root: Root;

function emit(name: string, payload: unknown) {
  act(() => (handlers.get(name) ?? []).forEach((handler) => handler({ payload })));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  if (!("checkVisibility" in HTMLElement.prototype)) {
    Object.assign(HTMLElement.prototype, { checkVisibility: () => true });
  }
  handlers.clear();
  opened.length = 0;
  closed.length = 0;
  useChatStore.setState({ browserMiniHover: false });
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function render(props: Partial<Parameters<typeof RealBrowserView>[0]> = {}) {
  act(() => root.render(
    <RealBrowserView viewId="aba-1" url="https://example.com" zoom={1} onUrl={() => undefined} onError={() => undefined} {...props} />,
  ));
}

describe("vista do navegador nativo", () => {
  it("um pop-up da página (OAuth) chega à aba com o id que o motor já criou", async () => {
    const onPopup = vi.fn();
    render({ onPopup });
    await act(async () => undefined);
    expect(opened).toEqual(["aba-1"]);
    emit("real-browser-popup", { id: "outra-aba", popup: "p-0", url: "https://accounts.example.com/" });
    expect(onPopup).not.toHaveBeenCalled();
    emit("real-browser-popup", { id: "aba-1", popup: "p-1", url: "https://accounts.example.com/o/oauth2" });
    expect(onPopup).toHaveBeenCalledWith({ id: "p-1", url: "https://accounts.example.com/o/oauth2" });
  });

  it("a página que se fecha sozinha avisa só a própria aba", async () => {
    const onClosedByPage = vi.fn();
    render({ onClosedByPage });
    await act(async () => undefined);
    emit("real-browser-closed", { id: "outra-aba" });
    expect(onClosedByPage).not.toHaveBeenCalled();
    emit("real-browser-closed", { id: "aba-1" });
    expect(onClosedByPage).toHaveBeenCalledTimes(1);
  });

  it("o mouse sobre a miniatura mostra a pílula e a pílula some ao sair da miniatura", async () => {
    render({ floatingPreview: true });
    await act(async () => undefined);
    emit("real-browser-mini-hover", { id: "aba-1", inside: true });
    expect(useChatStore.getState().browserMiniHover).toBe(true);
    emit("real-browser-mini-hover", { id: "aba-1", inside: false });
    expect(useChatStore.getState().browserMiniHover).toBe(false);
    emit("real-browser-mini-hover", { id: "aba-1", inside: true });
    render({ floatingPreview: false });
    expect(useChatStore.getState().browserMiniHover).toBe(false);
  });

  it("fora da miniatura o hover nativo não acende a pílula", async () => {
    render({ floatingPreview: false });
    await act(async () => undefined);
    emit("real-browser-mini-hover", { id: "aba-1", inside: true });
    expect(useChatStore.getState().browserMiniHover).toBe(false);
  });

  it("a aba do pop-up nasce com o id e o perfil do opener", () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://accounts.example.com/", { id: "p-1", browserProfileId: "trabalho" });
    expect(id).toBe("p-1");
    const view = useViewTabsStore.getState().views.find((v) => v.id === "p-1");
    expect(view).toMatchObject({ kind: "browser", cwd: "/projeto", browserProfileId: "trabalho" });
    expect(useViewTabsStore.getState().activeViewId).toBe("p-1");
  });
});
