import { useEffect, useMemo } from "react";

import {
  autoSettleCandidates,
  autoSettleDays,
  autoSettleDue,
  nextAutoSettleAt,
  type AutoSettleInput,
} from "@/features/chat/sidebar/autoSettle";
import { useAutoSettleChoice } from "@/features/chat/sidebar/autoSettlePrefs";
import { threadIdOf } from "@/features/chat/structured/model";
import { settleThread, useStructured } from "@/features/chat/structured/store";

/** O que a barra já sabe e entrega ao gancho: a lista, quem está ocupado, os fixados e a conversa aberta. */
export interface AutoSettleSource {
  readonly tabIds: readonly string[];
  readonly busy: readonly string[];
  readonly pinned: readonly string[];
  readonly selectedId: string | null;
  /** Último pedido seu por conversa, em segundos (a barra guarda assim). */
  readonly lastUserAt: Readonly<Record<string, number>>;
}

const MIN_DELAY_MS = 1_000;
const MAX_TIMEOUT_MS = 2_147_000_000;

/**
 * Concluir sozinho: agenda um único `setTimeout` para o próximo prazo, sem polling, e conclui as que
 * venceram. Quando a escolha está desligada, não agenda nada. Quem decide quem vence é `autoSettle.ts`.
 */
export function useAutoSettle(source: AutoSettleSource): void {
  const days = autoSettleDays(useAutoSettleChoice());
  const threads = useStructured((s) => s.threads);
  const settledThreadIds = useMemo(() => new Set(threads.filter((t) => t.state === "settled").map((t) => t.id)), [threads]);
  const { tabIds, busy, pinned, selectedId, lastUserAt } = source;
  const candidates = useMemo(
    () => autoSettleCandidates({ tabIds, busy, pinned, selectedId, settledThreadIds, threadOf: threadIdOf }),
    [tabIds, busy, pinned, selectedId, settledThreadIds],
  );

  useEffect(() => {
    if (days === null) return;
    let timer: number | null = null;
    const arm = (input: AutoSettleInput) => {
      const next = nextAutoSettleAt(input);
      if (next === null) return;
      timer = window.setTimeout(run, Math.min(Math.max(next - Date.now(), MIN_DELAY_MS), MAX_TIMEOUT_MS));
    };
    const run = () => {
      timer = null;
      const input: AutoSettleInput = { now: Date.now(), days, candidates, lastUserAt };
      const due = autoSettleDue(input);
      for (const tabId of due) {
        const threadId = threadIdOf(tabId);
        if (threadId) settleThread(threadId, true);
      }
      // As que acabaram de concluir saem da conta: o próximo prazo é o das que sobraram.
      arm({ ...input, candidates: candidates.filter((c) => !due.includes(c.tabId)) });
    };
    arm({ now: Date.now(), days, candidates, lastUserAt });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [days, candidates, lastUserAt]);
}
