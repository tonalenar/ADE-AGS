import { beforeEach, describe, expect, it } from "vitest";

import { setChatBrowser, toggleRightPanel, useChatStore } from "../store";

const rect = { left: 10, top: 20, width: 300, height: 200 };

beforeEach(() => {
  useChatStore.setState({ deviceFloat: null, browser: null, browserFloating: false, browserFloatRect: null, panel: null, lastPanel: null, surfaces: [] });
});

describe("recolher o painel com o navegador", () => {
  it("vira a miniatura em vez de sumir, como no T3", () => {
    setChatBrowser({ viewId: "v1", rect });
    useChatStore.setState({ panel: "browser" });
    toggleRightPanel();
    const state = useChatStore.getState();
    expect(state.panel).toBeNull();
    expect(state.browserFloating).toBe(true);
  });

  it("abrir o painel de novo devolve o navegador ao painel e fecha a miniatura", () => {
    setChatBrowser({ viewId: "v1", rect });
    useChatStore.setState({ panel: "browser" });
    toggleRightPanel();
    toggleRightPanel();
    const state = useChatStore.getState();
    expect(state.panel).toBe("browser");
    expect(state.browserFloating).toBe(false);
  });

  it("outro painel recolhe normalmente, sem miniatura", () => {
    setChatBrowser({ viewId: "v1", rect });
    useChatStore.setState({ panel: "diff" });
    toggleRightPanel();
    expect(useChatStore.getState().browserFloating).toBe(false);
  });
});
