import { exportMemory } from "@/features/memory/ipc";

const DAY = 86_400;

/** Dias inteiros que faltam (arredonda para cima); `null` quando o backend não informa prazo. */
export function remainingDays(remainingSeconds: number | null | undefined): number | null {
  if (typeof remainingSeconds !== "number" || !Number.isFinite(remainingSeconds)) return null;
  return Math.max(0, Math.ceil(remainingSeconds / DAY));
}

/** Quando faltam 3 dias ou menos o prazo é destacado como urgente. */
export const isExpiringSoon = (days: number | null): boolean => days !== null && days <= 3;

export type DeleteChoice = "export" | "skip";

/**
 * Exporta (se pedido) e só então apaga. Se a exportação falhar nada é apagado: o erro sobe e o
 * workspace continua intacto.
 */
export async function deleteWithChoice(
  workspaceId: string,
  choice: DeleteChoice,
  remove: (id: string) => Promise<void>,
): Promise<void> {
  if (choice === "export") await exportMemory(workspaceId);
  await remove(workspaceId);
}
