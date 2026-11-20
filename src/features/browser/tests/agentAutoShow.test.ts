// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { autoShowAgentBrowser } from "../agentBridge";
import { browserScope } from "@/features/chat/columnTabs";
import { publishMeasuredChatBrowser } from "@/features/chat/browserMeasurement";
import { setChatBrowser, toggleChatBrowserFloating, useChatStore } from "@/features/chat/store";
import { useUiStore } from "@/app/uiStore";
import { useViewTabsStore } from "@/features/tabs/viewStore";

const owner = { kind: "thread" as const, id: "thread:t1", label: "agente" };

beforeEach(() => {
  useUiStore.setState({ chatMode: true, shellMode: "chat" });
  useChatStore.setState({
    thread: "t1", panel: null, browser: null, browserFloating: false, browserFloatRect: null,
    columnTabs: [], columnActive: null, browserMiniHover: {},
  });
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [], portalViews: [] });
});

describe("miniatura automática do agente", () => {
  it("autoShow_com_painel_fechado_abre_o_painel_e_flutua_so_na_medida_real", () => {
    const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { owner, activate: false });

    autoShowAgentBrowser(viewId, owner);

    // Com o painel fechado não há slot para medir: o painel abre primeiro, e a aba mostra a página do agente.
    expect(useChatStore.getState().panel).toBe("browser");
    const tab = useChatStore.getState().columnTabs.find((candidate) => candidate.kind === "browser");
    expect(tab?.resources?.[browserScope("/projeto", owner)]).toBe(viewId);
    // Sem medida real do slot, a miniatura não abre (nada de retângulo inventado).
    expect(useChatStore.getState().browserFloating).toBe(false);

    // O slot mede a página do agente: só então a miniatura abre, com essa medida como origem.
    publishMeasuredChatBrowser(viewId, { left: 10, top: 20, width: 400, height: 300 });
    expect(useChatStore.getState().browserFloating).toBe(true);
    expect(useChatStore.getState().browser).toEqual({ viewId, rect: { left: 10, top: 20, width: 400, height: 300 } });
    expect(useChatStore.getState().panel).toBeNull();
  });

  it("autoShow_nao_alterna_para_flutuante_quando_navegador_ja_esta_visivel_no_painel", () => {
    const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { owner, activate: false });
    useChatStore.setState({
      panel: "browser",
      browserFloating: false,
      browser: { viewId, rect: { left: 600, top: 80, width: 420, height: 600 } },
    });

    autoShowAgentBrowser(viewId, owner);

    expect(useChatStore.getState().panel).toBe("browser");
    expect(useChatStore.getState().browserFloating).toBe(false);
  });

  it("toggleChatBrowserFloating_calcula_browserFloatRect_antes_de_ligar_floating", () => {
    const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { owner, activate: false });
    const shell = document.createElement("div");
    shell.setAttribute("data-chat-shell", "");
    const main = document.createElement("main");
    shell.appendChild(main);
    document.body.appendChild(shell);
    const rect = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
    shell.getBoundingClientRect = () => rect(0, 0, 1200, 900);
    main.getBoundingClientRect = () => rect(240, 0, 960, 900);

    try {
      setChatBrowser({ viewId, rect: { left: 700, top: 60, width: 460, height: 760 } });
      toggleChatBrowserFloating();

      const state = useChatStore.getState();
      expect(state.browserFloating).toBe(true);
      expect(state.browserFloatRect).not.toBeNull();
      expect(state.browserFloatRect!.width).toBeGreaterThan(0);
      expect(state.browserFloatRect!.height).toBeGreaterThan(0);
    } finally {
      shell.remove();
    }
  });
});
