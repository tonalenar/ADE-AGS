import { useEffect } from "react";

import { boardKeyOfTab, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { screenOf } from "@/features/terminal/terminalRegistry";

import { buildExtras, CHECKPOINT_MS, sendCheckpoints } from "./checkpoint";
import { saveActiveSnapshots } from "./conversationFlow";
import { useConversationsStore } from "./conversationsStore";
import { useSessionsStore } from "./store";

/**
 * Grava as conversas vivas a cada poucos minutos e quando a janela some de vista ou vai fechar, para que um
 * travamento não perca a conversa e a lista do projeto já mostre a atividade recente. Falhar nunca incomoda:
 * o arquivamento ao fechar a aba continua sendo a rede de segurança.
 */
export function useSessionCheckpoints(): void {
  // As conversas do workspace carregam logo que as abas voltam: sem elas, o que se abre não saberia a que
  // conversa ativa pertence, mesmo com a barra lateral recolhida.
  const hydrated = useTabsStore((s) => s.hydrated);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  useEffect(() => {
    if (hydrated) void useConversationsStore.getState().load(workspaceId);
  }, [hydrated, workspaceId]);

  useEffect(() => {
    let busy = false;
    const run = async () => {
      const { tabs, workspaceId, hydrated } = useTabsStore.getState();
      if (busy || !hydrated || tabs.length === 0) return;
      busy = true;
      try {
        const boards = useCanvasStore.getState().boards;
        const extras = buildExtras(
          tabs,
          (id) => screenOf(id, null, 40)?.lines ?? null,
          (tab) => boards[boardKeyOfTab(tab, boards)]?.nodes[tab.id] ?? null,
        );
        if (extras.length === 0) return;
        await sendCheckpoints(workspaceId, extras);
        await saveActiveSnapshots().catch(() => undefined);
        void useSessionsStore.getState().loadHistory(workspaceId);
      } catch (e) {
        console.error("checkpoint das conversas falhou", e);
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void run(), CHECKPOINT_MS);
    const onHide = () => { if (document.visibilityState === "hidden") void run(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", run);
    };
  }, []);
}
