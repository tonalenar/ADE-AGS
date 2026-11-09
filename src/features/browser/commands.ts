import { addSurface, setRightPanel, useChatStore } from "@/features/chat/store";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type BrowserView } from "@/features/tabs/viewTabs";
import { useUiStore } from "@/app/uiStore";
import { boardKeyOfTab, useCanvasStore } from "@/features/canvas/store";

export type PreviewCommand = "refresh" | "focusUrl" | "zoomIn" | "zoomOut" | "resetZoom";

export const PREVIEW_COMMAND_EVENT = "ade:browser-command";

export interface PreviewCommandEventDetail {
  viewId: string;
  command: PreviewCommand;
}

const visiblePreviewIds = new Set<string>();
let mostRecentVisiblePreviewId: string | null = null;

/** Mantém a lista de instâncias atualmente selecionadas/visíveis, inclusive portais do Canvas. */
export function setPreviewViewVisible(viewId: string, visible: boolean): void {
  if (visible) {
    visiblePreviewIds.add(viewId);
    mostRecentVisiblePreviewId = viewId;
  } else {
    visiblePreviewIds.delete(viewId);
    if (mostRecentVisiblePreviewId === viewId) {
      const remaining = [...visiblePreviewIds];
      mostRecentVisiblePreviewId = remaining[remaining.length - 1] ?? null;
    }
  }
}

function browserViewById(id: string | null | undefined): BrowserView | undefined {
  if (!id) return undefined;
  const state = useViewTabsStore.getState();
  const view = state.views.find((candidate) => candidate.id === id)
    ?? state.portalViews.find((candidate) => candidate.id === id);
  return view?.kind === "browser" ? view : undefined;
}

/** O navegador em foco segue a superfície visível, sem selecionar uma vista oculta. */
export function activePreviewViewId(): string | null {
  const chat = useChatStore.getState();
  const chatPreviewId = chat.browser?.viewId;
  if ((chat.panel === "browser" || chat.browserFloating)
    && chatPreviewId
    && visiblePreviewIds.has(chatPreviewId)
    && browserViewById(chatPreviewId)) {
    return chatPreviewId;
  }
  const views = useViewTabsStore.getState();
  const workspacePreview = browserViewById(views.activeViewId);
  if (workspacePreview && visiblePreviewIds.has(workspacePreview.id)) return workspacePreview.id;
  const candidates = [...visiblePreviewIds].filter((id) => browserViewById(id));
  if (mostRecentVisiblePreviewId && candidates.includes(mostRecentVisiblePreviewId)) return mostRecentVisiblePreviewId;
  return candidates[candidates.length - 1] ?? null;
}

/** Indica se o comando de alternância tem uma superfície compatível neste contexto. */
export function canToggleBrowserPreview(): boolean {
  const ui = useUiStore.getState();
  if (ui.chatMode && ui.shellMode === "chat") return true;

  const viewState = useViewTabsStore.getState();
  const activePreviewId = activePreviewViewId();
  if (activePreviewId && viewState.portalViews.some((view) => view.id === activePreviewId)) return false;
  const activeView = browserViewById(viewState.activeViewId);
  if (activeView && visiblePreviewIds.has(activeView.id)) return true;

  const tabs = useTabsStore.getState();
  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  if (!activeTab?.cwd) return false;
  return useCanvasStore.getState().modes[boardKeyOfTab(activeTab)] !== "canvas";
}

/** Alterna a prévia na conversa ou no workspace, reaproveitando uma vista pessoal existente. */
export function toggleBrowserPreview(): void {
  if (!canToggleBrowserPreview()) return;
  const ui = useUiStore.getState();
  if (ui.chatMode && ui.shellMode === "chat") {
    if (useChatStore.getState().panel === "browser") setRightPanel(null);
    else addSurface("browser");
    return;
  }

  const viewState = useViewTabsStore.getState();
  const active = browserViewById(viewState.activeViewId);
  if (active && visiblePreviewIds.has(active.id)) {
    viewState.showTerminal();
    return;
  }

  const tabs = useTabsStore.getState();
  const cwd = tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.cwd;
  if (!cwd) return;
  const existing = viewState.views.find((view): view is BrowserView => view.kind === "browser"
    && !view.owner
    && comparablePath(view.cwd) === comparablePath(cwd));
  if (existing) viewState.activateView(existing.id);
  else viewState.openBrowser(cwd, "", { activate: true });
}

/** Envia uma ação apenas à instância de preview visível no momento. */
export function runPreviewCommand(command: PreviewCommand): boolean {
  const viewId = activePreviewViewId();
  if (!viewId || typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent<PreviewCommandEventDetail>(PREVIEW_COMMAND_EVENT, {
    detail: { viewId, command },
  }));
  return true;
}
