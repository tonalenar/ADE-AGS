import { useEffect, useMemo, useRef } from "react";

import type { ConversationCard } from "../chatModel";
import { useChatLive } from "../liveStore";
import { setUnread } from "../shelf";
import { threadIdOf, threadStatusSignature } from "../structured/model";
import { useStructured } from "../structured/store";

/**
 * "Não lida": uma conversa que terminou de trabalhar sem estar aberta fica marcada; abrir a conversa
 * limpa a marca. Lê a fase de cada uma (o canal da aba, os eventos da conversa por protocolo) e só
 * reage à passagem de "trabalhando" para parado.
 */
export function useAutoUnread(cards: ConversationCard[], selectedId: string | null): void {
  const tabPhase = useChatLive((s) => s.phase);
  // Assina só a assinatura das conversas (fase, pedido, falha): o texto que chega numa conversa não recalcula "trabalhando".
  const threadIds = useMemo(() => cards.map((c) => threadIdOf(c.tabId)).filter((id): id is string => id !== null), [cards]);
  const threadSignature = useStructured((s) => threadStatusSignature(s.live, threadIds));
  const working = useMemo(() => {
    const threadLive = useStructured.getState().live;
    const out: Record<string, boolean> = {};
    for (const card of cards) {
      const thread = threadIdOf(card.tabId);
      out[card.tabId] = thread ? threadLive[thread]?.phase === "working" : tabPhase[card.tabId] === "working";
    }
    return out;
  }, [cards, tabPhase, threadSignature]);
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
