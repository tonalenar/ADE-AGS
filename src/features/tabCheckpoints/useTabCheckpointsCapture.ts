import { useEffect } from "react";

import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { onPromptSubmitted, recentPaste } from "@/features/terminal/terminalRegistry";

import { tabCheckpointAuto, tabCheckpointsPrune } from "./ipc";
import { autoCaptureFor, closedTabs } from "./model";

/** A primeira limpeza depois de abrir: as abas fechadas na sessão anterior. */
const BOOT_PRUNE_MS = 90_000;
/** Depois de fechar uma aba: o backend só solta pontos com mais de 10 min (ver `ORPHAN_GRACE_MS`). */
const CLOSE_PRUNE_MS = 11 * 60_000;
const PERIODIC_PRUNE_MS = 30 * 60_000;

/**
 * Ponto de restauração a cada Enter num terminal de agente (a pessoa ou um colado do app), e a
 * limpeza dos pontos das abas fechadas. As mensagens que o backend escreve direto no PTY (peers,
 * `ags tab send`, chat) tiram o ponto lá mesmo, em `submit_prompt_seen`.
 */
export function useTabCheckpointsCapture(): void {
  useEffect(() => {
    const lastAt = new Map<string, number>();
    return onPromptSubmitted((tabId, at, typed) => {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
      // A terminal pelada não é uma conversa com agente: cada comando viraria um ponto.
      if (!tab || tab.agentId === SHELL_AGENT_ID || !tab.cwd) return;
      const capture = autoCaptureFor({ pasted: recentPaste(tabId, at), typed, lastAt: lastAt.get(tabId), at });
      if (!capture) return;
      lastAt.set(tabId, at);
      tabCheckpointAuto(tabId, tab.cwd, capture.message, capture.author).catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => { tabCheckpointsPrune().catch(() => undefined); }, ms);
    };
    schedule(BOOT_PRUNE_MS);
    const periodic = setInterval(() => { tabCheckpointsPrune().catch(() => undefined); }, PERIODIC_PRUNE_MS);
    const unsubscribe = useTabsStore.subscribe((state, prev) => {
      if (state.tabs !== prev.tabs && closedTabs(prev.tabs, state.tabs).length > 0) schedule(CLOSE_PRUNE_MS);
    });
    return () => { clearTimeout(timer); clearInterval(periodic); unsubscribe(); };
  }, []);
}
