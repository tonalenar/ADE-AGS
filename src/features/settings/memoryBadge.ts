import type { MemoryPendingCounts } from "@/features/memory/types";

/** Sugestões pendentes do workspace e de todas as missões. Pura. */
export function pendingTotal(counts: MemoryPendingCounts): number {
  return counts.workspace + Object.values(counts.byMission).reduce((sum, n) => sum + n, 0);
}

/** O número do selo: vazio sem pendências, "99+" acima de 99. Pura. */
export function badgeText(total: number): string {
  return total <= 0 ? "" : total > 99 ? "99+" : String(total);
}
