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
const openedPlaces: Array<{ cornerRadius?: number }> = [];
const placedVisibility: boolean[] = [];
const coversSpy = vi.fn();
vi.mock("../nativeSurface", async (importOriginal) => {
  const original = await importOriginal<typeof import("../nativeSurface")>();
  return { ...original, coversOf: (...args: Parameters<typeof original.coversOf>) => { coversSpy(); return original.coversOf(...args); } };
});
const placedPlaces: Array<{ visible: boolean; cornerRadius?: number; visibleRect?: unknown }> = [];
const closed: string[] = [];
vi.mock("../realBrowser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../realBrowser")>()),
  realBrowserOpen: (id: string, _url: string, place: { cornerRadius?: number }) => { opened.push(id); openedPlaces.push(place); return Promise.resolve(); },
  realBrowserPlace: (_id: string, place: { visible: boolean; cornerRadius?: number; visibleRect?: unknown }) => { placedVisibility.push(place.visible); placedPlaces.push(place); return Promise.resolve(); },
  realBrowserClose: (id: string) => { closed.push(id); return Promise.resolve(); },
}));

import { RealBrowserView } from "../RealBrowserView";
import { setChatBrowserMiniHover, useChatStore } from "@/features/chat/store";
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
  openedPlaces.length = 0;
  closed.length = 0;
  placedVisibility.length = 0;
  placedPlaces.length = 0;
  useChatStore.setState({ browserMiniHover: {} });
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

function render(props: Partial<Parameters<typeof RealBrowserView>[0]> = {}) {
  act(() => root.render(
    <RealBrowserView viewId="aba-1" url="https://example.com" zoom={1} onUrl={() => undefined} onError={() => undefined} {...props} />,
  ));
}

describe("vista do navegador nativo", () => {
  it("envia o raio da moldura flutuante para a superfície nativa", async () => {
    render({ floatingPreview: true });
    await act(async () => undefined);
    expect(openedPlaces[0]?.cornerRadius).toBe(16);
  });

  it("desmontagem_marca_superficie_como_invisivel", async () => {
    render();
    await act(async () => undefined);
    await act(async () => root.unmount());

    expect(placedVisibility[placedVisibility.length - 1]).toBe(false);
    expect(closed).toEqual(["aba-1"]);
  });

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
    expect(useChatStore.getState().browserMiniHover["aba-1"]).toBe(true);
    emit("real-browser-mini-hover", { id: "aba-1", inside: false });
    expect(useChatStore.getState().browserMiniHover["aba-1"]).toBeUndefined();
    emit("real-browser-mini-hover", { id: "aba-1", inside: true });
    render({ floatingPreview: false });
    expect(useChatStore.getState().browserMiniHover["aba-1"]).toBeUndefined();
  });

  it("o hover de uma miniatura não acende a pílula de outra", () => {
    setChatBrowserMiniHover("aba-1", true);
    expect(useChatStore.getState().browserMiniHover["outra-aba"]).toBeUndefined();
    setChatBrowserMiniHover("aba-1", false);
    expect(useChatStore.getState().browserMiniHover).toEqual({});
  });

  it("fora da miniatura o hover nativo não acende a pílula", async () => {
    render({ floatingPreview: false });
    await act(async () => undefined);
    emit("real-browser-mini-hover", { id: "aba-1", inside: true });
    expect(useChatStore.getState().browserMiniHover["aba-1"]).toBeUndefined();
  });

  it("um pointerenter refaz a cobertura antes dos 120 ms do cache", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // Tempo congelado: o cache de 120 ms só é testado pela entrada do mouse, não pelo relógio real.
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "checkVisibility").mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON: () => ({}) } as DOMRect);
    render({ floatingPreview: true });
    await act(async () => undefined);
    // A medida do mount já calculou a cobertura: dentro do prazo, o quadro seguinte não recalcula.
    coversSpy.mockClear();
    act(() => frames.shift()?.(0));
    expect(coversSpy).not.toHaveBeenCalled();

    // A entrada do mouse num elemento novo muda o que está por cima: o próximo quadro recalcula já.
    document.dispatchEvent(new Event("pointerenter"));
    act(() => frames.shift()?.(0));
    expect(coversSpy).toHaveBeenCalled();
  });

  it("trocar_projeto_nao_reabre_a_pagina", async () => {
    // A partição é escolhida na abertura: mudar a pasta da vista não fecha nem reabre a página nativa.
    render({ projectPath: "/projeto-a" });
    await act(async () => undefined);
    render({ projectPath: "/projeto-b" });
    await act(async () => undefined);

    expect(opened).toEqual(["aba-1"]);
    expect(closed).toEqual([]);
  });

  it("escondida_manda_o_lugar_vazio_duas_vezes_e_depois_cala", async () => {
    // Escondida (outra aba, canvas no modo Abas): o nativo só esconde no segundo lugar vazio seguido. Depois disso a
    // vista não manda mais nada enquanto continuar escondida.
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    vi.spyOn(HTMLElement.prototype, "checkVisibility").mockReturnValue(false);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render();
    await act(async () => undefined);
    // Um frame por vez, com a promessa do envio anterior resolvida entre eles, como no navegador.
    for (let i = 0; i < 6; i++) await act(async () => { frames.shift()?.(0); });

    expect(placedPlaces.filter((place) => place.visibleRect === null)).toHaveLength(2);
    expect(placedPlaces.every((place) => place.visibleRect === null)).toBe(true);
  });

  it("trocar_forma_nao_reabre_superficie", async () => {
    render();
    await act(async () => undefined);
    render({ floatingPreview: true, zoom: 0.7 });
    await act(async () => undefined);

    expect(opened).toEqual(["aba-1"]);
    expect(closed).toEqual([]);
  });

  it("atualiza o raio nativo ao mudar a forma para PiP", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render();
    await act(async () => undefined);
    render({ floatingPreview: true });
    act(() => frames.shift()?.(performance.now()));

    expect(opened).toEqual(["aba-1"]);
    expect(placedPlaces.some((place) => place.cornerRadius === 16)).toBe(true);
  });

  it("a aba do pop-up nasce com o id e o perfil do opener", () => {
    const id = useViewTabsStore.getState().openBrowser("/projeto", "https://accounts.example.com/", { id: "p-1", browserProfileId: "trabalho" });
    expect(id).toBe("p-1");
    const view = useViewTabsStore.getState().views.find((v) => v.id === "p-1");
    expect(view).toMatchObject({ kind: "browser", cwd: "/projeto", browserProfileId: "trabalho" });
    expect(useViewTabsStore.getState().activeViewId).toBe("p-1");
  });
});
