import { chatShellOn, useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";

import { requestTimelineFind, useChatStore } from "../store";

const TIMELINE_TUIS = new Set(["claude-code", "codex"]);

/** Identifica somente a conversa visível que tem timeline pesquisável. */
export function activeTimelineConversationKey(): string | null {
  if (!chatShellOn(useUiStore.getState())) return null;
  const chat = useChatStore.getState();
  if (chat.composing) return null;
  if (chat.thread) return `thread:${chat.thread}`;

  const { activeTabId, tabs } = useTabsStore.getState();
  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  return tab && TIMELINE_TUIS.has(tab.agentId) ? `tab:${tab.id}` : null;
}

/** Abre a busca na timeline da conversa ativa, quando ela oferece uma. */
export function findInActiveTimeline(): boolean {
  const key = activeTimelineConversationKey();
  if (!key) return false;
  requestTimelineFind(key);
  return true;
}
