// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { autoShowAgentBrowser } from "../agentBridge";
import { browserScope } from "@/features/chat/columnTabs";
import { closeChatBrowserFloating, openColumnTab, setChatBrowser, setColumnTabResource, toggleChatBrowserFloating, useChatStore } from "@/features/chat/store";
import { useUiStore } from "@/app/uiStore";
import { useViewTabsStore } from "@/features/tabs/viewStore";

const owner = { kind: "thread" as const, id: "thread:t1", label: "agente" };

function mountChatShell(): HTMLDivElement {
  const shell = document.createElement("div");
  shell.setAttribute("data-chat-shell", "");
  const main = document.createElement("main");
  shell.appendChild(main);
  document.body.appendChild(shell);
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
  shell.getBoundingClientRect = () => rect(0, 0, 1200, 900);
  main.getBoundingClientRect = () => rect(240, 0, 960, 900);
  return shell;
}

beforeEach(() => {
  useUiStore.setState({ chatMode: true, shellMode: "chat" });
  useChatStore.setState({
    thread: "t1", panel: null, browser: null, browserFloating: false, browserFloatRect: null,
    browserFloatPinned: false, browserFloatDismissed: {}, browserAutoShown: {},
    columnTabs: [], columnActive: null, browserMiniHover: {},
  });
  useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [], portalViews: [] });
});

describe("miniatura automática do agente", () => {
  it("autoShow_com_painel_fechado_abre_pip_direto_sem_abrir_o_painel_em_3_navegacoes", () => {
    const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { owner, activate: false });
    const shell = mountChatShell();
    const seenPanels: Array<string | null> = [];
    const unsubscribe = useChatStore.subscribe((state) => { seenPanels.push(state.panel); });

    try {
      autoShowAgentBrowser(viewId, owner);
      autoShowAgentBrowser(viewId, owner);
      autoShowAgentBrowser(viewId, owner);

      // O painel direito nunca é aberto nem fechado ao navegar 3x com ele fechado.
      expect(seenPanels.every((panel) => panel === null)).toBe(true);
      expect(useChatStore.getState().panel).toBeNull();
      expect(useChatStore.getState().browserFloating).toBe(true);
      expect(useChatStore.getState().browser?.viewId).toBe(viewId);
      expect(useChatStore.getState().browserFloatRect).not.toBeNull();
    } finally {
      unsubscribe();
      shell.remove();
    }
  });

  it("autoShow_respeita_fechamento_do_pip_pelo_usuario_nas_acoes_seguintes", () => {
    const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { owner, activate: false });
    const shell = mountChatShell();

    try {
      autoShowAgentBrowser(viewId, owner);
      expect(useChatStore.getState().browserFloating).toBe(true);

      // Usuário fecha a miniatura: novas navegações do agente não podem reabrir o PiP nem o painel.
      closeChatBrowserFloating();
      expect(useChatStore.getState().browserFloating).toBe(false);
      expect(useChatStore.getState().panel).toBeNull();

      autoShowAgentBrowser(viewId, owner);
      autoShowAgentBrowser(viewId, owner);
      expect(useChatStore.getState().browserFloating).toBe(false);
      expect(useChatStore.getState().panel).toBeNull();
    } finally {
      shell.remove();
    }
  });

  it("autoShow_com_outro_painel_aberto_preserva_o_painel_do_usuario", () => {
    const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { owner, activate: false });
    const shell = mountChatShell();
    useChatStore.setState({ panel: "diff" });

    try {
      autoShowAgentBrowser(viewId, owner);
      expect(useChatStore.getState().panel).toBe("diff");
      expect(useChatStore.getState().browserFloating).toBe(true);

      // Fechar o PiP também não pode fechar o painel Diff do usuário.
      closeChatBrowserFloating();
      expect(useChatStore.getState().panel).toBe("diff");
      expect(useChatStore.getState().browserFloating).toBe(false);
    } finally {
      shell.remove();
    }
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

  it("autoShow_nao_rouba_pagina_de_usuario_ja_aberta_no_painel_navegador", () => {
    const userViewId = useViewTabsStore.getState().openBrowser("/projeto", "https://usuario.dev", { activate: false });
    const agentViewId = useViewTabsStore.getState().openBrowser("/projeto", "https://agente.dev", { owner, activate: false });
    const tabId = openColumnTab("browser");
    const scope = browserScope("/projeto", owner);
    setColumnTabResource(tabId, scope, userViewId);
    useChatStore.setState({
      panel: "browser",
      browserFloating: false,
      browser: { viewId: userViewId, rect: { left: 600, top: 80, width: 420, height: 600 } },
    });

    autoShowAgentBrowser(agentViewId, owner);

    const tab = useChatStore.getState().columnTabs.find((candidate) => candidate.id === tabId);
    expect(tab?.resources?.[scope]).toBe(userViewId);
    expect(useChatStore.getState().browserFloating).toBe(false);
  });

  it("toggleChatBrowserFloating_calcula_browserFloatRect_antes_de_ligar_floating", () => {
    const viewId = useViewTabsStore.getState().openBrowser("/projeto", "https://example.com", { owner, activate: false });
    const shell = mountChatShell();

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
