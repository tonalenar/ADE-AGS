import { beforeEach, describe, expect, it } from "vitest";

import { addSurface, closeDeviceFloat, openDeviceFloat, setChatBrowser, toggleChatBrowserFloating, useChatStore } from "../store";

const rect = { left: 10, top: 20, width: 300, height: 200 };

beforeEach(() => {
  useChatStore.setState({ deviceFloat: null, browser: null, browserFloating: false, browserFloatRect: null, panel: null, surfaces: [] });
});

describe("aparelho flutuando sobre a conversa", () => {
  it("entra nas superfícies da conversa, para os agentes o controlarem, sem abrir a aba do painel", () => {
    openDeviceFloat("ios");
    const state = useChatStore.getState();
    expect(state.deviceFloat).toBe("ios");
    expect(state.surfaces).toContain("ios");
    expect(state.panel).toBeNull();
  });

  it("um preview por vez: o navegador flutuante sai quando um aparelho flutua", () => {
    setChatBrowser({ viewId: "v1", rect });
    toggleChatBrowserFloating();
    expect(useChatStore.getState().browserFloating).toBe(true);
    openDeviceFloat("android");
    expect(useChatStore.getState().browserFloating).toBe(false);
    expect(useChatStore.getState().deviceFloat).toBe("android");
  });

  it("abrir o navegador flutuante tira o aparelho flutuante", () => {
    openDeviceFloat("ios");
    setChatBrowser({ viewId: "v1", rect });
    toggleChatBrowserFloating();
    expect(useChatStore.getState().deviceFloat).toBeNull();
    expect(useChatStore.getState().browserFloating).toBe(true);
  });

  it("abrir a aba do aparelho no painel dispensa o flutuante dele: o mesmo aparelho não tem duas telas", () => {
    openDeviceFloat("ios");
    addSurface("ios");
    expect(useChatStore.getState().deviceFloat).toBeNull();
    expect(useChatStore.getState().panel).toBe("ios");
  });

  it("fechar o flutuante não tira o aparelho das superfícies: fechar a janela não o desliga", () => {
    openDeviceFloat("ios");
    closeDeviceFloat();
    expect(useChatStore.getState().deviceFloat).toBeNull();
    expect(useChatStore.getState().surfaces).toContain("ios");
  });
});
