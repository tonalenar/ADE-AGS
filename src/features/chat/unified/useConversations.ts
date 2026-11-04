import { useMemo } from "react";

import { useCanvasStore } from "@/features/canvas/store";
import { useStructured } from "@/features/chat/structured/store";
import { useChatStore } from "@/features/chat/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { useTabsStore } from "@/features/tabs/store";

import { selectedRef } from "./selection";
import { selectConversations } from "./selectConversations";
import type { UnifiedConversation } from "./types";

/** As conversas abertas (abas e protocolo) com time, papel, canvas e missão, de uma fonte só. Só leitura. */
export function useConversations(): UnifiedConversation[] {
  const tabs = useTabsStore((s) => s.tabs);
  const threads = useStructured((s) => s.threads);
  const teams = useTeamIndex((s) => s.teams);
  const boards = useCanvasStore((s) => s.boards);
  return useMemo(() => selectConversations({ tabs, threads, teams, boards }), [tabs, threads, teams, boards]);
}

/** A ref da conversa à vista (a mesma em Chat, Abas e Canvas): ver `selectedRef`. */
export function useSelectedRef(): string | null {
  const thread = useChatStore((s) => s.thread);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  return selectedRef({ thread, activeTabId });
}
