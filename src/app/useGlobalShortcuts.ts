import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { activateItem, currentLayout, splitFocusedAgentGroup } from "@/features/tabs/layout/layoutStore";
import { findGroup } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { tabsOfWorkspace } from "@/features/tabs/workspaceTabs";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { viewsOfWorkspace } from "@/features/tabs/viewTabs";
import { chatShellOn, useUiStore } from "@/app/uiStore";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { TERMINAL_ZOOM } from "@/features/terminal/theme";
import { useShortcutPreferences } from "./shortcutPrefs";
import { openTeamPanelFocused, setRightPanel, toggleDiffPanel, togglePanelMaximized, toggleRightPanel, useChatStore } from "@/features/chat/store";
import { newConversation, newConversationLocal, newConversationWithoutProject, stopFocusedConversation } from "@/features/chat/chatActions";
import { useBotToastStore } from "@/shared/brand/botToastStore";
import { findInActiveTimeline } from "@/features/chat/timeline/findModel";
import { runStoredProjectScript } from "@/features/chat/projectScriptRunner";
import { activeComposerCommandTarget, isAgentModelPickerTargetMounted, isComposerCommandAvailable, isFilePickerTargetMounted, isPromptStashTargetMounted, runComposerCommand, takeDesktopSnapshot, toggleAgentModelPicker, toggleFilePicker as toggleComposerFilePicker, togglePromptStash } from "@/features/chat/composerCommands";
import { activePreviewViewId, canToggleBrowserPreview, runPreviewCommand, toggleBrowserPreview } from "@/features/browser/commands";
import { copyVisiblePullRequestNumber, isPullRequestCopyAvailable } from "@/features/forge/pullRequestCommands";
import { selectedConversationPinTarget, toggleSelectedConversationPinned } from "@/features/chat/selectedConversationCommands";
import { useWorkspacesStore } from "@/features/workspaces/store";
import { canOpenWorkspaceAgent, requestWorkspaceAgent } from "@/features/tabs/workspaceCommands";
import { canToggleChatTerminal, toggleChatTerminal } from "@/features/chat/terminalCommands";

import { WORKSPACE_PATH, matchShortcut, nextTabId, resolveGoto } from "./shortcuts";

/**
 * Engancha los atajos globales. Se monta una sola vez, en `AppShell`.
 *
 * Cada ventana de Tauri tiene su propio webview, así que este listener ya es por ventana
 * sin hacer nada especial: Ctrl+Tab cicla las tabs de la ventana enfocada y de ninguna otra.
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Durante a gravação, o acorde precisa chegar ao controle de Configurações.
      if (useShortcutPreferences.getState().recordingId) return;
      const shortcut = matchShortcut(e, location.pathname);
      if (!shortcut) return;
      if (shortcut.action.kind === "undoThreadAction") {
        const active = document.activeElement;
        if (active?.closest("[data-terminal-tab], [data-browser-column], input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
        if (!useBotToastStore.getState().toasts.some((toast) => toast.undoable && toast.onAction)) return;
      }
      // Com o modo chat desligado o acorde não é nosso: segue para o terminal.
      if (shortcut.action.kind === "toggleChat" && !useUiStore.getState().chatMode) return;
      if (shortcut.action.kind === "newConversation" && !useUiStore.getState().chatMode) return;
      if (shortcut.action.kind === "newConversationLocal" && !useUiStore.getState().chatMode) return;
      if (shortcut.action.kind === "newConversationWithoutProject" && !useUiStore.getState().chatMode) return;
      if (shortcut.action.kind === "openTeamPanel" && !chatShellOn(useUiStore.getState())) return;
      if (shortcut.action.kind === "newPanelSurface" && !chatShellOn(useUiStore.getState())) return;
      if (shortcut.action.kind === "toggleChatSidebar" && !chatShellOn(useUiStore.getState())) return;
      if (shortcut.action.kind === "toggleRightPanel" && !chatShellOn(useUiStore.getState())) return;
      if ((shortcut.action.kind === "closeRightPanel" || shortcut.action.kind === "toggleRightPanelMaximized")
        && (!chatShellOn(useUiStore.getState()) || useChatStore.getState().panel === null)) return;
      if (shortcut.action.kind === "previewCommand" && !activePreviewViewId()) return;
      if (shortcut.action.kind === "toggleBrowserPreview" && !canToggleBrowserPreview()) return;
      if (shortcut.action.kind === "toggleProjectSearch") {
        const state = useUiStore.getState();
        const { tabs, activeTabId } = useTabsStore.getState();
        if (state.shellMode !== "workspace" || !location.pathname.startsWith(WORKSPACE_PATH)
          || !tabs.some((tab) => tab.id === activeTabId && !!tab.cwd)) return;
      }
      if (shortcut.action.kind === "toggleFilePicker") {
        const state = useUiStore.getState();
        if (!chatShellOn(state) || !isFilePickerTargetMounted(activeComposerCommandTarget())) return;
      }
      if (shortcut.action.kind === "toggleModelPicker") {
        const state = useUiStore.getState();
        if (!chatShellOn(state) || !isAgentModelPickerTargetMounted(activeComposerCommandTarget())) return;
      }
      if (shortcut.action.kind === "togglePromptStash") {
        const state = useUiStore.getState();
        if (!chatShellOn(state) || !isPromptStashTargetMounted(activeComposerCommandTarget())) return;
      }
      if (shortcut.action.kind === "composerCommand") {
        const state = useUiStore.getState();
        if (!chatShellOn(state) || !isComposerCommandAvailable(activeComposerCommandTarget(), shortcut.action.command)) return;
      }
      if (shortcut.action.kind === "toggleDiffPanel" && !chatShellOn(useUiStore.getState())) return;
      if (shortcut.action.kind === "copyPullRequestNumber" && !isPullRequestCopyAvailable()) return;
      if (shortcut.action.kind === "togglePinnedConversation" && !selectedConversationPinTarget()) return;
      if (shortcut.action.kind === "newWorkspaceAgent" && !canOpenWorkspaceAgent(location.pathname)) return;
      if (shortcut.action.kind === "toggleChatTerminal" && !canToggleChatTerminal(location.pathname)) return;

      if (shortcut.action.kind === "quickThread" || shortcut.action.kind === "quickModel" || shortcut.action.kind === "quickPalette") {
        const event = new CustomEvent("ade:chat-quick-select", {
          cancelable: true,
          detail: {
            kind: shortcut.action.kind === "quickThread" ? "thread" : shortcut.action.kind === "quickModel" ? "model" : "palette",
            index: shortcut.action.index,
          },
        });
        window.dispatchEvent(event);
        // Sem uma conversa/opção naquela posição, o acorde segue para o sistema ou app ativo.
        if (!event.defaultPrevented) return;
      }

      // Se corta acá SIEMPRE que el acorde sea nuestro, aunque después no haya nada que
      // hacer (ciclar sin tabs): si no, el acorde seguiría viaje hasta la terminal y el
      // agente recibiría un Ctrl+M suelto que no pidió nadie.
      e.preventDefault();
      e.stopPropagation();

      // El estado se lee al APRETAR, no al montar: así el handler se registra una sola vez
      // en vez de volver a suscribirse cada vez que se abre o se cierra una tab.
      const { tabs, activeTabId, activateTab } = useTabsStore.getState();

      if (shortcut.action.kind === "quickThread" || shortcut.action.kind === "quickModel" || shortcut.action.kind === "quickPalette") return;

      if (shortcut.action.kind === "textZoom") {
        const { zoom, setZoom } = useTerminalPrefsStore.getState();
        const { delta } = shortcut.action;
        setZoom(delta === 0 ? TERMINAL_ZOOM.default : zoom + delta * TERMINAL_ZOOM.step);
        return;
      }

      if (shortcut.action.kind === "toggleChat") {
        const { shellMode, setShellMode } = useUiStore.getState();
        setShellMode(shellMode === "chat" ? "workspace" : "chat");
        // Voltando às abas, o fundo é o workspace (sem abas, o AppShell manda para a inicial).
        if (shellMode === "chat" && tabs.length > 0) navigate(WORKSPACE_PATH);
        return;
      }

      if (shortcut.action.kind === "openTeamPanel") {
        openTeamPanelFocused();
        return;
      }

      if (shortcut.action.kind === "newPanelSurface") {
        // Mostra o seletor sem fechar nem desmontar o terminal/navegador, que continuam
        // montados fora do conteúdo visível do painel.
        setRightPanel("empty");
        return;
      }

      if (shortcut.action.kind === "toggleRightPanel") {
        toggleRightPanel();
        return;
      }

      if (shortcut.action.kind === "toggleChatSidebar") {
        window.dispatchEvent(new Event("ade:chat-sidebar-toggle"));
        return;
      }

      if (shortcut.action.kind === "closeRightPanel") {
        setRightPanel(null);
        return;
      }

      if (shortcut.action.kind === "toggleRightPanelMaximized") {
        togglePanelMaximized();
        return;
      }

      if (shortcut.action.kind === "toggleBrowserPreview") {
        toggleBrowserPreview();
        return;
      }

      if (shortcut.action.kind === "previewCommand") {
        runPreviewCommand(shortcut.action.command);
        return;
      }

      if (shortcut.action.kind === "toggleProjectSearch") {
        useUiStore.getState().openDrawer("search");
        return;
      }

      if (shortcut.action.kind === "toggleFilePicker") {
        toggleComposerFilePicker(activeComposerCommandTarget());
        return;
      }

      if (shortcut.action.kind === "toggleModelPicker") {
        toggleAgentModelPicker(activeComposerCommandTarget());
        return;
      }

      if (shortcut.action.kind === "togglePromptStash") {
        togglePromptStash(activeComposerCommandTarget());
        return;
      }

      if (shortcut.action.kind === "takeSnapshot") {
        // O `when` já exige o botão montado no composer visível; aqui só reaproveitamos o clique.
        takeDesktopSnapshot(activeComposerCommandTarget());
        return;
      }

      if (shortcut.action.kind === "composerCommand") {
        runComposerCommand(activeComposerCommandTarget(), shortcut.action.command);
        return;
      }

      if (shortcut.action.kind === "toggleDiffPanel") {
        toggleDiffPanel();
        return;
      }

      if (shortcut.action.kind === "copyPullRequestNumber") {
        copyVisiblePullRequestNumber();
        return;
      }

      if (shortcut.action.kind === "cycleAppearance") {
        window.dispatchEvent(new Event("ade:appearance-cycle"));
        return;
      }

      if (shortcut.action.kind === "selectTheme" || shortcut.action.kind === "toggleThemeEditor") {
        const state = useUiStore.getState();
        const alreadyOpen = location.pathname.startsWith("/settings") && state.settingsSection === "appearance";
        if (shortcut.action.kind === "toggleThemeEditor" && alreadyOpen) {
          navigate(tabs.length > 0 ? WORKSPACE_PATH : "/");
          return;
        }
        state.setSettingsSection("appearance");
        if (!location.pathname.startsWith("/settings")) state.setSettingsOpen(true);
        return;
      }

      if (shortcut.action.kind === "findConversation") {
        const diffRoot = document.activeElement?.closest<HTMLElement>("[data-ade-diff-search-root]");
        if (diffRoot) diffRoot.dispatchEvent(new Event("ade:diff-find"));
        else findInActiveTimeline();
        return;
      }

      if (shortcut.action.kind === "toggleDictation") {
        window.dispatchEvent(new Event("ade:voice-input-toggle"));
        return;
      }

      if (shortcut.action.kind === "newConversation") {
        useUiStore.getState().setShellMode("chat");
        newConversation();
        navigate("/");
        return;
      }

      if (shortcut.action.kind === "newConversationLocal") {
        useUiStore.getState().setShellMode("chat");
        newConversationLocal();
        navigate("/");
        return;
      }

      if (shortcut.action.kind === "newConversationWithoutProject") {
        useUiStore.getState().setShellMode("chat");
        newConversationWithoutProject();
        navigate("/");
        return;
      }

      if (shortcut.action.kind === "stopThread") {
        stopFocusedConversation();
        return;
      }

      if (shortcut.action.kind === "undoThreadAction") {
        useBotToastStore.getState().undoLatest();
        return;
      }

      if (shortcut.action.kind === "togglePinnedConversation") {
        toggleSelectedConversationPinned();
        return;
      }

      if (shortcut.action.kind === "runProjectScript") {
        runStoredProjectScript(shortcut.action.cwd, shortcut.action.scriptId, shortcut.action.name);
        return;
      }

      if (shortcut.action.kind === "navigateHistory") {
        navigate(shortcut.action.delta);
        return;
      }

      if (shortcut.action.kind === "focusOpenWorkspace") {
        void useWorkspacesStore.getState().focusAdjacentOpenWorkspace(shortcut.action.delta).catch(console.error);
        return;
      }

      if (shortcut.action.kind === "splitWorkspaceTerminal") {
        splitFocusedAgentGroup(shortcut.action.side);
        return;
      }
      if (shortcut.action.kind === "newWorkspaceAgent") {
        requestWorkspaceAgent(location.pathname);
        return;
      }
      if (shortcut.action.kind === "toggleChatTerminal") {
        toggleChatTerminal(location.pathname);
        return;
      }

      if (shortcut.action.kind === "openPalette") {
        const { paletteOpen, setPaletteOpen } = useUiStore.getState();
        setPaletteOpen(!paletteOpen);
        return;
      }

      if (shortcut.action.kind === "openSettings") {
        // Interruptor, igual que los de sección: si ya está abierto, se cierra.
        if (location.pathname.startsWith("/settings")) {
          navigate(tabs.length > 0 ? "/workspace" : "/");
          return;
        }
        useUiStore.getState().setSettingsOpen(true);
        return;
      }

      if (shortcut.action.kind === "goto") {
        const target = resolveGoto(shortcut.action.path, location.pathname, tabs.length > 0);
        if (target) navigate(target);
        return;
      }

      // Con grupos, cicla por las tabs del grupo enfocado: son las de la tira donde se
      // está trabajando, igual que en VS Code.
      const layout = currentLayout();
      const group = layout ? findGroup(layout, layout.focused) : undefined;
      if (group) {
        const key = nextTabId(group.items, group.active, shortcut.action.delta);
        if (key) activateItem(key);
        navigate(WORKSPACE_PATH);
        return;
      }

      // Cicla dentro del workspace, no por todas las tabs de la ventana: saltar a una
      // que la barra ni siquiera muestra es cambiar de carpeta a ciegas.
      // Las tabs de archivo y navegador cuentan: están en la misma barra.
      const agentIds = tabsOfWorkspace(tabs, activeTabId).map((t) => t.id);
      const activeCwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null;
      const views = useViewTabsStore.getState();
      const viewIds = viewsOfWorkspace(views.views, activeCwd).map((v) => v.id);
      const current = viewIds.includes(views.activeViewId ?? "") ? views.activeViewId : activeTabId;
      const next = nextTabId([...agentIds, ...viewIds], current, shortcut.action.delta);
      if (!next) return;
      if (viewIds.includes(next)) {
        views.activateView(next);
      } else {
        activateTab(next);
        views.showTerminal();
      }
      // Cambiar de tab sin mostrarla sería cambiar a ciegas: si estabas en una sección, el
      // atajo te lleva a la terminal de la tab a la que acabás de moverte.
      navigate(WORKSPACE_PATH);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [navigate, location.pathname]);
}
