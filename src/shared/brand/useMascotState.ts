import { useEffect, useMemo } from "react";

import { fleetSummary, type FleetSummary } from "@/features/runs/fleetOrder";
import { useAgentActivity } from "@/features/terminal/activity";
import { useRunsStore } from "@/features/runs/store";

import { mascotStateFor, type MascotState } from "./Mascot";
import { mascotSignalsFrom } from "./mascotSignals";
import { useNowTick } from "./nowTick";

/** Quando algo esteve ativo pela última vez (a partir da abertura do app), para saber há quanto
 *  tempo o bot está parado. Compartilhado: todas as instâncias do hook concordam. */
let lastBusyAt = Date.now();

/**
 * O humor do mascote, tirado da frota: esperando você pesa mais do que trabalhando,
 * porque é o que pede uma ação. A barra de status e a Home usam o mesmo, para o
 * mascote nunca dizer duas coisas diferentes na mesma tela.
 *
 * "Trabalhando" inclui os agentes de terminal (Claude Code, Codex…), não só a frota: a
 * maior parte do trabalho acontece neles (ver `terminal/activity.ts`). No repouso entram
 * ainda "falhou" (uma tarefa falhou há pouco) e "dormindo" (faz muito tempo que nada acontece).
 */
export function useMascotState(): { state: MascotState; summary: FleetSummary } {
  const tasks = useRunsStore((s) => s.tasks);
  const approvals = useRunsStore((s) => s.approvals);
  const terminalWorking = useAgentActivity((s) => s.working);
  const now = useNowTick();
  const result = useMemo(() => {
    const summary = fleetSummary(tasks, approvals);
    const base = mascotStateFor(summary);
    const busy = base !== "idle" || terminalWorking;
    const signals = busy ? {} : mascotSignalsFrom(tasks, now, lastBusyAt);
    const state = busy ? (base === "idle" ? "working" : base) : mascotStateFor(summary, signals);
    return { state, summary, busy };
  }, [tasks, approvals, terminalWorking, now]);
  // Ao ficar ocupado e ao parar: o relógio do sono conta do último momento de atividade.
  useEffect(() => {
    lastBusyAt = Date.now();
  }, [result.busy]);
  return { state: result.state, summary: result.summary };
}
