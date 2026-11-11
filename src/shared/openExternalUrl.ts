import { openUrl as openSystemUrl } from "@tauri-apps/plugin-opener";

import { chatShellOn, useUiStore } from "@/app/uiStore";
import { addSurface, useChatStore } from "@/features/chat/store";
import { useStructured } from "@/features/chat/structured/store";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type BrowserView, type ViewOwner } from "@/features/tabs/viewTabs";
import { readBrowserSearchPreferences } from "@/features/browser/searchPreferences";

function sameOwner(view: BrowserView, owner: ViewOwner | null): boolean {
  return owner
    ? view.owner?.kind === owner.kind && view.owner.id === owner.id
    : !view.owner;
}

function normalizeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Abre links HTTP(S) no destino configurado pela pessoa em Configurações. */
export async function openExternalUrl(raw: string, options: { modifier?: boolean } = {}): Promise<void> {
  const url = normalizeHttpUrl(raw.trim());
  // Conteúdo de Markdown, agentes e terminais é entrada não confiável. Só abrimos HTTP(S),
  // nunca esquemas como javascript:, file: ou data:.
  if (!url) return;
  const configured = readBrowserSearchPreferences().linkTarget;
  const target = options.modifier ? (configured === "app" ? "system" : "app") : configured;
  if (target !== "app") {
    await openSystemUrl(url);
    return;
  }

  const tabState = useTabsStore.getState();
  const chat = useChatStore.getState();
  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeTabId) ?? null;

  if (chatShellOn(useUiStore.getState())) {
    const thread = !chat.composing && chat.thread
      ? useStructured.getState().threads.find((candidate) => candidate.id === chat.thread) ?? null
      : null;
    const conversationTab = !chat.composing && !thread ? activeTab : null;
    const cwd = thread?.cwd ?? conversationTab?.cwd ?? chat.composeFolder ?? activeTab?.cwd ?? "";
    const owner: ViewOwner | null = thread
      ? { kind: "thread", id: `thread:${thread.id}`, label: thread.title }
      : conversationTab
        ? { kind: "tab", id: conversationTab.id, label: conversationTab.agentLabel }
        : null;
    const views = useViewTabsStore.getState();
    const existing = views.views.find((view): view is BrowserView => view.kind === "browser"
      && comparablePath(view.cwd) === comparablePath(cwd)
      && sameOwner(view, owner));
    if (existing) views.updateView(existing.id, { url });
    else views.openBrowser(cwd, url, { activate: false, owner: owner ?? undefined });
    addSurface("browser");
    return;
  }

  useViewTabsStore.getState().openBrowser(activeTab?.cwd ?? "", url);
}
