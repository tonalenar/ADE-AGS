import type { AccountLimits } from "@/features/accounts/types";

/**
 * Los topes de una cuenta en el diálogo de Límites. Guardar escribe los dos campos enteros, así
 * que el diálogo no puede partir de un "sin topes" inventado: si los topes de la cuenta todavía
 * no llegaron (o no se pudieron leer), guardar borraría los que ya había.
 */
export type LimitsLoad =
  | { status: "loading" }
  | { status: "ready"; limits: AccountLimits }
  | { status: "error"; message: string };

/**
 * Lee los topes de varias cuentas sin que una que falla deje a las demás sin los suyos.
 * Las que fallan simplemente no aparecen (la fila no muestra badges, y el diálogo los vuelve a leer).
 */
export async function loadLimitsTolerant(
  ids: string[],
  get: (id: string) => Promise<AccountLimits>,
): Promise<Record<string, AccountLimits>> {
  const settled = await Promise.allSettled(ids.map((id) => get(id)));
  const out: Record<string, AccountLimits> = {};
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") out[ids[i]] = result.value;
  });
  return out;
}

/** Lee los topes de una cuenta para el diálogo: siempre los del disco, no los de la lista. */
export async function loadLimitsFor(id: string, get: (id: string) => Promise<AccountLimits>): Promise<LimitsLoad> {
  try {
    return { status: "ready", limits: await get(id) };
  } catch (e) {
    return { status: "error", message: String(e) };
  }
}

export type LimitsFormProblem = "notLoaded" | "maxConcurrent" | "budget";

/** Lo que guardaría el formulario, o por qué no se puede. Sin topes leídos no se guarda nada. */
export function parseLimitsForm(
  load: LimitsLoad,
  concurrent: string,
  budget: string,
): { ok: true; limits: AccountLimits } | { ok: false; problem: LimitsFormProblem } {
  if (load.status !== "ready") return { ok: false, problem: "notLoaded" };
  const limits: AccountLimits = {
    maxConcurrent: concurrent.trim() ? Math.floor(Number(concurrent)) : null,
    dailyBudgetUsd: budget.trim() ? Number(budget.replace(",", ".")) : null,
  };
  if (limits.maxConcurrent !== null && !(limits.maxConcurrent >= 1)) return { ok: false, problem: "maxConcurrent" };
  if (limits.dailyBudgetUsd !== null && !(limits.dailyBudgetUsd >= 0)) return { ok: false, problem: "budget" };
  return { ok: true, limits };
}
