import { useCallback, useMemo } from "react";

import { readTuning } from "@/features/canvas/tabTuning";
import { useTabsStore } from "@/features/tabs/store";

import { readAccess, type ConversationCard } from "../chatModel";
import { useChatLive } from "../liveStore";
import { threadIdOf } from "../structured/model";
import { useStructured } from "../structured/store";
import type { TeamPolicy } from "./ipc";
import { CLOSED, type LiveInput } from "./teamModel";

/**
 * O que se sabe agora de cada conversa do time, venha ela de uma aba (o canal do transcript,
 * `liveStore`) ou de uma conversa por protocolo (os eventos dela, `structured/store`). Só lê.
 */
export function useTeamLive(cards: ConversationCard[] = []) {
  const tabs = useTabsStore((s) => s.tabs);
  const phase = useChatLive((s) => s.phase);
  const question = useChatLive((s) => s.question);
  const awaiting = useChatLive((s) => s.awaiting);
  const threads = useStructured((s) => s.threads);
  const live = useStructured((s) => s.live);
  const byKey = useMemo(() => new Map(cards.map((c) => [c.tabId, c])), [cards]);

  const liveOf = useCallback((ref: string): LiveInput => {
    const thread = threadIdOf(ref);
    if (thread) {
      const row = threads.find((t) => t.id === thread);
      if (!row || row.state !== "active") return CLOSED;
      const state = live[thread];
      const requests = state?.requests ?? [];
      return {
        open: true,
        working: state?.phase === "working",
        awaiting: requests.some((r) => r.kind !== "question"),
        question: requests.some((r) => r.kind === "question"),
      };
    }
    if (!tabs.some((t) => t.id === ref)) return CLOSED;
    return { open: true, working: phase[ref] === "working", awaiting: ref in awaiting, question: !!question[ref] };
  }, [tabs, phase, question, awaiting, threads, live]);

  const nameOf = useCallback((ref: string): string | null => {
    const card = byKey.get(ref);
    if (card) return card.title;
    const thread = threadIdOf(ref);
    if (thread) return threads.find((t) => t.id === thread && t.state === "active")?.title ?? null;
    return tabs.find((t) => t.id === ref)?.title ?? null;
  }, [byKey, threads, tabs]);

  /** O modelo de agora: o da conversa por protocolo ou o do comando da aba. */
  const modelOf = useCallback((ref: string): string | null => {
    const thread = threadIdOf(ref);
    if (thread) {
      const row = threads.find((t) => t.id === thread);
      return row ? [row.model, row.effort].filter(Boolean).join(" · ") || null : null;
    }
    const tab = tabs.find((t) => t.id === ref);
    if (!tab) return null;
    const tuning = readTuning(tab.agentId, tab.command);
    return [tuning.model, tuning.effort].filter(Boolean).join(" · ") || null;
  }, [threads, tabs]);

  const branchOf = useCallback((ref: string): string | null => byKey.get(ref)?.branch ?? null, [byKey]);

  /** O acesso da conversa como política do time (o orquestrador não tem política gravada). */
  const accessOf = useCallback((ref: string): TeamPolicy | null => {
    const thread = threadIdOf(ref);
    const access = thread
      ? threads.find((t) => t.id === thread)?.access ?? null
      : (() => { const tab = tabs.find((t) => t.id === ref); return tab ? readAccess(tab.agentId, tab.command).access : null; })();
    if (!access) return null;
    if (access === "full") return "full";
    if (access === "edits" || access === "safe") return "edits";
    if (access === "plan") return "read";
    return "ask";
  }, [threads, tabs]);

  return { liveOf, nameOf, modelOf, branchOf, accessOf };
}
