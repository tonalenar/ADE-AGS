import { chatShellOn, useUiStore } from "@/app/uiStore";
import { useStructured } from "@/features/chat/structured/store";
import { threadIdOf } from "@/features/chat/structured/model";
import { setRightPanel, setTerminalOpen, useChatStore } from "@/features/chat/store";
import { hasTimeline } from "@/features/chat/chatModel";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { isFullscreenRoute } from "@/features/chat/chatSpaces";

interface TerminalTarget {
  tabId: string;
  drawer: boolean;
}

function activeChatTerminal(pathname: string): TerminalTarget | null {
  if (!chatShellOn(useUiStore.getState()) || isFullscreenRoute(pathname)) return null;
  const { tabs, activeTabId } = useTabsStore.getState();
  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  if (!tab?.cwd || tab.agentId === SHELL_AGENT_ID) return null;

  // Uma TUI com timeline usa a gaveta própria, salvo quando há uma conversa estruturada
  // associada à aba; nesse caso o painel da direita abre um shell na pasta da conversa.
  const linkedThreadId = threadIdOf(tab.id);
  const linkedThread = linkedThreadId
    ? useStructured.getState().threads.some((thread) => thread.id === linkedThreadId)
    : false;
  return { tabId: tab.id, drawer: hasTimeline(tab.agentId) && !linkedThread };
}

/** Diz se o terminal da conversa atual pode ser alternado sem mudar de workspace. */
export function canToggleChatTerminal(pathname: string): boolean {
  return activeChatTerminal(pathname) !== null;
}

/** Reutiliza o mesmo destino da barra do Chat e não desmonta a TUI existente. */
export function toggleChatTerminal(pathname: string): boolean {
  const target = activeChatTerminal(pathname);
  if (!target) return false;

  if (target.drawer) {
    const open = useChatStore.getState().terminalOpen[target.tabId] ?? false;
    setTerminalOpen(target.tabId, !open);
  } else {
    setRightPanel(useChatStore.getState().panel === "shell" ? null : "shell");
  }
  return true;
}
