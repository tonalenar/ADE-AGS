import { useEffect, useMemo, useRef } from "react";

import type { ConversationCard } from "../chatModel";
import { useChatLive } from "../liveStore";
import { setUnread } from "../shelf";
import { threadIdOf } from "../structured/model";
import { useStructured } from "../structured/store";

/**
 * "Não lida": uma conversa que terminou de trabalhar sem estar aberta fica marcada; abrir a conversa
 * limpa a marca. Lê a fase de cada uma (o canal da aba, os eventos da conversa por protocolo) e só
 * reage à passagem de "trabalhando" para parado.
 */
export function useAutoUnread(cards: ConversationCard[], selectedId: string | null): void {
  const tabPhase = useChatLive((s) => s.phase);
  const threadLive = useStructured((s) => s.live);
  const working = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const card of cards) {
      const thread = threadIdOf(card.tabId);
      out[card.tabId] = thread ? threadLive[thread]?.phase === "working" : tabPhase[card.tabId] === "working";
    }
    return out;
  }, [cards, tabPhase, threadLive]);
  const before = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const [id, now] of Object.entries(working)) {
      if (before.current[id] === true && !now && id !== selectedId) setUnread(id, true);
    }
    before.current = working;
  }, [working, selectedId]);
  // Abrir limpa a marca.
  useEffect(() => { if (selectedId) setUnread(selectedId, false); }, [selectedId]);
}
