/**
 * Contrato del guarda de presupuesto y de los límites de plan (Etapa 21, ítem 14).
 * El Backend serializa estos DTOs en camelCase (`#[serde(rename_all = "camelCase")]`).
 *
 * Comandos Tauri esperados (wrappers en `budgetIpc.ts`):
 *  - `mission_budget(missionId)            -> BudgetStatus`
 *  - `mission_raise_budget(missionId, budgetUsd) -> BudgetStatus`   (sube el techo; queda registrado)
 *  - `mission_budget_continue(missionId, action) -> BudgetStatus`   (sigue pese al exceso; queda registrado)
 *  - `plan_limits()                        -> PlanLimits[]`          (solo lectura)
 * Evento: `cc-budget-changed` con `{ missionId }` cuando cambia el nivel.
 */

export type BudgetLevel = "ok" | "warning" | "exceeded";

/** Qué se intentó hacer cuando el techo estaba excedido y hay que confirmar. */
export type BudgetGatedAction = "recruit" | "startTask";

export interface BudgetStatus {
  missionId: string;
  level: BudgetLevel;
  /** `null` = sin techo (nivel `ok`, barra oculta); `<= 0` es dato anómalo y cuenta como `exceeded`. */
  budgetUsd: number | null;
  /** Costo estimado: suma por pestaña, solo tokens medidos. */
  costUsd: number;
  /** costUsd / budgetUsd * 100 (puede pasar de 100); `null` sin techo. */
  pct: number | null;
  /** Modelos con tokens pero sin precio: no entran en `costUsd` y se avisan. */
  unpricedModels: string[];
  /** Pestañas/agentes con uso no medido (Gemini, etc.): se muestran en gris. */
  unmeasuredAgents: string[];
  /** El usuario ya eligió seguir pese al exceso (registrado en la misión). */
  continueAnyway: boolean;
  /** Tendencia: USD por hora en la última ventana; `null` si no hay datos. */
  trendUsdPerHour: number | null;
}

/** Cuando `level === "exceeded"` y no hay `continueAnyway`, estas acciones piden confirmación. */
export const needsBudgetConfirm = (s: Pick<BudgetStatus, "level" | "continueAnyway">): boolean =>
  s.level === "exceeded" && !s.continueAnyway;

export type PlanProvider = "claude" | "codex";

export interface PlanWindow {
  /** Ej. "5h", "weekly". */
  label: string;
  /** 0-100 consumido; `null` si la CLI no lo expone. */
  usedPct: number | null;
  /** ISO-8601 de cuando se reinicia la ventana; `null` si no se sabe. */
  resetsAt: string | null;
}

export interface PlanLimits {
  provider: PlanProvider;
  accountId: string | null;
  /** `false` = la CLI/archivos no exponen límites: se muestra «no medido». */
  measured: boolean;
  windows: PlanWindow[];
}

/** Cerca del límite = 80 % o más, igual que el guarda de presupuesto. */
export const NEAR_LIMIT_PCT = 80;
export const nearLimit = (w: PlanWindow): boolean => w.usedPct !== null && w.usedPct >= NEAR_LIMIT_PCT;

/** Nivel a partir de los números, con los mismos umbrales del Backend (80 % / 100 %). Pura. */
export function levelOf(costUsd: number, budgetUsd: number | null): BudgetLevel {
  if (budgetUsd === null) return "ok";
  if (budgetUsd <= 0) return "exceeded";
  const pct = (costUsd / budgetUsd) * 100;
  return pct >= 100 ? "exceeded" : pct >= 80 ? "warning" : "ok";
}
