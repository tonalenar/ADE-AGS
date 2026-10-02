import { useMemo } from "react";

import { fleetSummary, type FleetSummary } from "@/features/runs/fleetOrder";
import { useAgentActivity } from "@/features/terminal/activity";
import { useRunsStore } from "@/features/runs/store";

import { mascotStateFor, type MascotState } from "./Mascot";

/**
 * O humor do mascote, tirado da frota: esperando você pesa mais do que trabalhando,
 * porque é o que pede uma ação. A barra de status e a Home usam o mesmo, para o
 * mascote nunca dizer duas coisas diferentes na mesma tela.
 *
 * "Trabalhando" inclui os agentes de terminal (Claude Code, Codex…), não só a frota: a
 * maior parte do trabalho acontece neles (ver `terminal/activity.ts`).
 */
export function useMascotState(): { state: MascotState; summary: FleetSummary } {
  const tasks = useRunsStore((s) => s.tasks);
  const approvals = useRunsStore((s) => s.approvals);
  const terminalWorking = useAgentActivity((s) => s.working);
  return useMemo(() => {
    const summary = fleetSummary(tasks, approvals);
    const state = mascotStateFor(summary);
    // Esperando-te pesa más que trabajando; quieto + agentes de terminal escribiendo = trabajando.
    return { state: state === "idle" && terminalWorking ? "working" : state, summary };
  }, [tasks, approvals, terminalWorking]);
}
