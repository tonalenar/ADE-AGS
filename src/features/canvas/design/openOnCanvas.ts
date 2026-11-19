import { boardKey, boardKeyOfTab, missionBoardKey, missionBoardKeysOf, missionOfKey, sessionBoardKey, useCanvasStore } from "../store";
import { designApi } from "./designApi";
import { openDesignOn } from "./openStore";
import { useTabsStore } from "@/features/tabs/store";
import { useChatStore } from "@/features/chat/store";
import { useStructured } from "@/features/chat/structured/store";
import { threadKey } from "@/features/chat/structured/model";
import { comparablePath } from "@/features/tabs/viewTabs";

/**
 * `ags design open`: marca no canvas da conversa ativa da pasta/missão. Também grava a chave
 * mesmo antes de o canvas ser carregado, para a próxima abertura.
 */
export async function openDesignOnCanvases(designId: string): Promise<string[]> {
  const { design } = await designApi.get(designId);
  const tabs = useTabsStore.getState();
  const chat = useChatStore.getState();
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  const activeThread = chat.thread ? useStructured.getState().threads.find((row) => row.id === chat.thread) : undefined;
  const owner = design.ownerTabId ? tabs.tabs.find((tab) => tab.id === design.ownerTabId) : undefined;
  const activeCanvasThread = useCanvasStore.getState().activeThread;
  const activeThreadRef = activeThread ? threadKey(activeThread.id) : null;
  const conversationKey = owner ? boardKeyOfTab(owner)
    : activeThread ? (activeCanvasThread?.ref === activeThreadRef ? activeCanvasThread.key : sessionBoardKey(activeThread.cwd, activeThreadRef!))
    : active ? boardKeyOfTab(active) : null;
  let keys: string[] = [];
  if (design.missionId) {
    keys = missionBoardKeysOf(design.missionId);
    if (keys.length === 0) {
      const cwd = design.workspace || owner?.cwd || activeThread?.cwd || active?.cwd || "";
      keys = [missionBoardKey(cwd, design.missionId)];
    }
    const activeMission = conversationKey && missionOfKey(conversationKey) === design.missionId ? conversationKey : null;
    if (activeMission) keys = [activeMission];
  } else if (design.workspace) {
    const workspace = comparablePath(design.workspace);
    const matchingConversation = !!conversationKey && [activeThread?.cwd, owner?.cwd, active?.cwd]
      .some((cwd) => !!cwd && comparablePath(cwd) === workspace);
    keys = [matchingConversation ? conversationKey : boardKey(design.workspace)];
  }
  for (const key of keys) openDesignOn(key, design.id);
  return keys;
}
