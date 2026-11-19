import { boardKey, boardKeyOfTab, canvasActions, hasSessionArtifacts, sessionBoardKey, useCanvasStore } from "@/features/canvas/store";
import { activationListeners, useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { openConversation } from "../chatActions";
import { threadIdOf } from "../structured/model";
import { openThread, useStructured } from "../structured/store";
import { useChatStore } from "../store";
import { useTeamIndex } from "../team/teamIndex";
import { homeBoardKey } from "./selection";

/** O canvas em que a conversa por protocolo `ref` mora (ver `homeBoardKey`). */
function threadBoard(ref: string): string {
  const id = threadIdOf(ref);
  const row = useStructured.getState().threads.find((t) => t.id === id);
  const team = useTeamIndex.getState().teams.find((t) => t.orchestrator === ref || t.members.some((m) => m.member === ref));
  const lead = team?.orchestrator;
  const leadThread = lead ? useStructured.getState().threads.find((t) => `thread:${t.id}` === lead) : undefined;
  const leadTab = lead ? useTabsStore.getState().tabs.find((t) => t.id === lead) : undefined;
  const boards = useCanvasStore.getState().boards;
  const leadCwd = leadThread?.cwd ?? team?.cwd ?? row?.cwd ?? "";
  const storedSpecial = team?.boardKey && ["#m:", "#c:", "#cmp:"].some((sep) => team.boardKey!.includes(sep)) ? team.boardKey : undefined;
  const storedCanvasBoard = team?.origin === "canvas" ? team.boardKey ?? undefined : undefined;
  const leadHomeBoard = lead ? homeBoardKey(lead, { boards, cwd: leadCwd, sessionBoardKey: sessionBoardKey(leadCwd, lead), cwdKey: boardKey }) : undefined;
  const leadSpecial = leadHomeBoard && ["#m:", "#c:", "#cmp:"].some((sep) => leadHomeBoard.includes(sep)) ? leadHomeBoard : undefined;
  const teamBoardKey = lead
    ? leadTab ? boardKeyOfTab(leadTab, boards)
      : storedSpecial ?? leadSpecial ?? storedCanvasBoard ?? leadHomeBoard
    : undefined;
  let key = homeBoardKey(ref, { boards, cwd: row?.cwd ?? "", teamBoardKey, cwdKey: boardKey });
  // Na primeira ativação, uma conversa por protocolo que já tinha cartão no canvas da pasta vai para o novo
  // canvas com as cordas, a coroa e o papel dela (movidos, não copiados: ver `moveSessionArtifacts`).
  const sourceKey = row ? boardKey(row.cwd) : null;
  const source = sourceKey ? boards[sourceKey] : undefined;
  const conversationRefs = new Set([
    ...useTabsStore.getState().tabs.map((tab) => tab.id),
    ...useStructured.getState().threads.map((thread) => "thread:" + thread.id),
  ]);
  const legacyConversationLink = !team && source?.edges.some((edge) =>
    (edge.a === ref && conversationRefs.has(edge.b)) || (edge.b === ref && conversationRefs.has(edge.a)));
  if (legacyConversationLink && sourceKey && key.includes("#s:") && !boards[key]?.threads[ref]) {
    // Uma ligação de conversa montada à mão na pasta mantém o grupo no canvas legado.
    key = sourceKey;
  } else if (sourceKey && source && key !== sourceKey && key.includes("#s:") && useTeamIndex.getState().loaded && hasSessionArtifacts(source, ref)) {
    canvasActions.moveSessionFrom(sourceKey, key, ref);
  }
  return key;
}

/** Mantém `activeThread` do canvas em dia com a conversa por protocolo aberta, venha a abertura de onde vier. */
function syncActiveThread(): void {
  const thread = useChatStore.getState().thread;
  const current = useCanvasStore.getState().activeThread;
  if (!thread) {
    if (current) useCanvasStore.setState({ activeThread: null });
    return;
  }
  const ref = `thread:${thread}`;
  const key = threadBoard(ref);
  if (current?.ref !== ref || current.key !== key) useCanvasStore.setState({ activeThread: { ref, key } });
}

/**
 * Escolhe uma conversa em QUALQUER modo: a mesma ref à vista no Chat, nas Abas e no Canvas.
 * Protocolo: abre a conversa (o `ProtocolPane` nas Abas, o cartão no Canvas). TUI: ativa a aba e mostra o
 * terminal. Em qualquer caso pede ao canvas que centre o nó dela; o canvas só desenha o cartão se o
 * canvas dela estiver no modo Canvas. Não toca em `<Terminal>`: só estado.
 */
export function selectConversation(ref: string): void {
  const threadId = threadIdOf(ref);
  if (threadId) {
    openThread(threadId);
    syncActiveThread();
    useViewTabsStore.getState().showTerminal();
    canvasActions.focusRef(useCanvasStore.getState().activeThread?.key ?? threadBoard(ref), ref);
    return;
  }
  openConversation(ref);
  const tab = useTabsStore.getState().tabs.find((t) => t.id === ref);
  if (tab) canvasActions.focusRef(boardKeyOfTab(tab), ref);
}

/** Liga a seleção única: abrir uma conversa por protocolo fixa o canvas dela; ativar uma aba fecha a conversa por protocolo. */
export function startSelectionSync(): () => void {
  const offChat = useChatStore.subscribe((s, p) => { if (s.thread !== p.thread) syncActiveThread(); });
  const offThreads = useStructured.subscribe((s, p) => { if (s.threads !== p.threads && useChatStore.getState().thread) syncActiveThread(); });
  const onActivate = () => {
    // Ativar uma aba (a tira, o canvas, a sidebar) é escolher o terminal: a conversa por protocolo sai da frente.
    if (useChatStore.getState().thread) useChatStore.setState({ thread: null });
  };
  activationListeners.add(onActivate);
  syncActiveThread();
  return () => { offChat(); offThreads(); activationListeners.delete(onActivate); };
}
