/**
 * Quem conta ao orquestrador quem está no time dele.
 *
 * Antes o aviso só saía quando a pessoa mexia no canvas com o mouse (coroa, corda, papel). Um time montado por
 * outro caminho — um subagente recrutado pelo `ags`, uma conversa reaberta, abas que entraram na conversa — nunca
 * chegava ao orquestrador, e ele seguia fazendo tudo sozinho com o subagente parado esperando. Agora o aviso
 * segue o canvas: qualquer mudança no time de um orquestrador o avisa, uma vez por mudança (`shouldAnnounce`).
 */
import { useTabsStore } from "@/features/tabs/store";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";

import { forgetOrchestrator, orchestratorNotice, shouldAnnounce } from "./orchestratorNotice";
import { useCanvasStore } from "./store";

/** Espera o canvas assentar (uma corda e o papel costumam vir juntos) antes de avisar. */
const SETTLE_MS = 600;

/** Avisa os orquestradores de `ids` no canvas `key` cujo time mudou desde o último aviso. */
export function announceToOrchestrators(key: string, ids: string[]): void {
  const board = useCanvasStore.getState().boards[key];
  if (!board) return;
  const tabs = useTabsStore.getState().tabs;
  for (const id of ids) {
    if (!board.orchestrators.includes(id)) { forgetOrchestrator(id); continue; }
    // Só para um agente aberto nesta janela: o aviso vai para a terminal dele.
    if (!tabs.some((tab) => tab.id === id)) continue;
    if (!shouldAnnounce(board, id)) continue;
    const text = orchestratorNotice(board, tabs, id);
    if (text) sendWhenReady(id, text);
  }
}

/** Liga o aviso automático: a cada mudança nos canvases desta janela, avisa quem precisa. Missões ficam de
 *  fora (o líder da missão recebe o próprio briefing). Devolve o desligar. */
export function initOrchestratorAnnouncements(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (!useTabsStore.getState().hydrated) return;
    for (const [key, board] of Object.entries(useCanvasStore.getState().boards)) {
      if (key.includes("#m:") || board.orchestrators.length === 0) continue;
      announceToOrchestrators(key, board.orchestrators);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, SETTLE_MS);
  };
  const unsubBoards = useCanvasStore.subscribe((state, prev) => { if (state.boards !== prev.boards) schedule(); });
  const unsubTabs = useTabsStore.subscribe((state, prev) => { if (state.hydrated !== prev.hydrated || state.tabs !== prev.tabs) schedule(); });
  schedule();
  return () => { clearTimeout(timer); unsubBoards(); unsubTabs(); };
}
