import { useMemo } from "react";

import { boardKey, useCanvasStore } from "@/features/canvas/store";
import { useStructured } from "@/features/chat/structured/store";
import { useChatStore } from "@/features/chat/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { useTabsStore } from "@/features/tabs/store";

import { selectedRef } from "./selection";
import { selectConversations } from "./selectConversations";
import type { UnifiedConversation } from "./types";

const selectTabs = (s: ReturnType<typeof useTabsStore.getState>) => s.tabs;
const selectActiveTabId = (s: ReturnType<typeof useTabsStore.getState>) => s.activeTabId;
const selectThreads = (s: ReturnType<typeof useStructured.getState>) => s.threads;
const selectTeams = (s: ReturnType<typeof useTeamIndex.getState>) => s.teams;
const selectBoards = (s: ReturnType<typeof useCanvasStore.getState>) => s.boards;
const selectChatThread = (s: ReturnType<typeof useChatStore.getState>) => s.thread;

/** As conversas abertas (abas e protocolo) com time, papel, canvas e missão, de uma fonte só. Só leitura. */
export function useConversations(): UnifiedConversation[] {
  const tabs = useTabsStore(selectTabs);
  const threads = useStructured(selectThreads);
  const teams = useTeamIndex(selectTeams);
  const boards = useCanvasStore(selectBoards);
  // `selectConversations` memoiza o resultado no módulo pelas 4 fontes: todos os hooks compartilham o cálculo.
  return useMemo(() => selectConversations({ tabs, threads, teams, boards, cwdKey: boardKey }), [tabs, threads, teams, boards]);
}

/** A ref da conversa à vista (a mesma em Chat, Abas e Canvas): ver `selectedRef`. */
export function useSelectedRef(): string | null {
  const thread = useChatStore(selectChatThread);
  const activeTabId = useTabsStore(selectActiveTabId);
  return selectedRef({ thread, activeTabId });
}
