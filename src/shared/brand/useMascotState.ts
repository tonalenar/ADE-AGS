import { useMemo } from "react";

import { fleetSummary, type FleetSummary } from "@/features/runs/fleetOrder";
import { useRunsStore } from "@/features/runs/store";

import { mascotStateFor, type MascotState } from "./Mascot";

/**
 * O humor do mascote, tirado da frota: esperando você pesa mais do que trabalhando,
 * porque é o que pede uma ação. A barra de status e a Home usam o mesmo, para o
 * mascote nunca dizer duas coisas diferentes na mesma tela.
 */
export function useMascotState(): { state: MascotState; summary: FleetSummary } {
  const tasks = useRunsStore((s) => s.tasks);
  const approvals = useRunsStore((s) => s.approvals);
  return useMemo(() => {
    const summary = fleetSummary(tasks, approvals);
    return { state: mascotStateFor(summary), summary };
  }, [tasks, approvals]);
}
