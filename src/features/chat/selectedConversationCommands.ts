import { useTabsStore } from "@/features/tabs/store";
import { chatShellOn, useUiStore } from "@/app/uiStore";

import { useChatStore } from "./store";
import { togglePinned } from "./shelf";
import { useStructured } from "./structured/store";
import { selectedRef } from "./unified/selection";

/** A seleção pode ser uma aba TUI ou uma conversa por protocolo; ambas usam a ref unificada. */
export function selectedConversationPinTarget(): string | null {
  if (!chatShellOn(useUiStore.getState())) return null;
  const chat = useChatStore.getState();
  if (chat.composing) return null;
  const tabs = useTabsStore.getState();
  const ref = selectedRef({ thread: chat.thread, activeTabId: tabs.activeTabId });
  if (!ref) return null;

  const isOpen = chat.thread
    ? useStructured.getState().threads.some((thread) => thread.id === chat.thread)
    : tabs.tabs.some((tab) => tab.id === ref);
  return isOpen ? ref : null;
}

/** Revalida a conversa no instante da ação; não altera o agente ou o estado do PTY. */
export function toggleSelectedConversationPinned(): string | null {
  const target = selectedConversationPinTarget();
  if (!target) return null;
  togglePinned(target);
  return target;
}
