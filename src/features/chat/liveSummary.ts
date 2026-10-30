import { useEffect, useMemo, useState } from "react";

import { snapshotActivity, turnLive, type Activity } from "./activityModel";
import { useChatLive } from "./liveStore";
import { usePermissions } from "./permissions/permissionsStore";
import { threadIdOf } from "./structured/model";
import { useStructured } from "./structured/store";

/** O "agora" que avança de segundo em segundo enquanto `active` (o tempo do turno na tela). */
export function useNow(active: boolean, stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [active, stepMs]);
  return now;
}

export interface LiveSummary {
  working: boolean;
  /** Parado esperando a pessoa (permissão ou pergunta). */
  waiting: boolean;
  startedAt: number | null;
  activity: Activity;
}

/**
 * O resumo ao vivo de uma conversa para a sidebar e o cabeçalho. Conversa por protocolo: os itens
 * que chegam pelo evento do agente. Aba (TUI): o estado do canal (fase, começo do turno e a
 * ferramenta pendente), sem ler a timeline de cada aba.
 */
export function useLiveSummary(key: string): LiveSummary {
  const threadId = threadIdOf(key);
  const thread = useStructured((s) => (threadId ? s.live[threadId] : undefined));
  const phase = useChatLive((s) => s.phase[key]);
  const turn = useChatLive((s) => s.turn[key]);
  const question = useChatLive((s) => !!s.question[key]);
  const awaiting = useChatLive((s) => key in s.awaiting);
  const prompt = usePermissions((s) => s.tui.some((p) => p.tabId === key));
  return useMemo(() => {
    if (threadId) {
      const waiting = (thread?.requests.length ?? 0) > 0;
      const working = thread?.phase === "working" || waiting;
      const live = turnLive(thread?.items ?? [], waiting);
      return { working, waiting, startedAt: live.startedAt, activity: live.activity };
    }
    const waiting = question || awaiting || prompt;
    const working = phase === "working" || waiting;
    return { working, waiting, startedAt: turn?.startedAt ?? null, activity: snapshotActivity(turn?.tools ?? [], waiting) };
  }, [threadId, thread, phase, turn, question, awaiting, prompt]);
}
