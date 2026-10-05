import type { Mission } from "./types";

/** Por qué falló una misión (contrato con el clasificador del backend). */
export type FailureClass = "access" | "limit" | "model" | "crash" | "timeout";

export const FAILURE_CLASSES: readonly FailureClass[] = ["access", "limit", "model", "crash", "timeout"];

/** Sin clasificar (misiones anteriores o falla no reconocida): se muestra como "unknown", sin inventar causa. */
export type FailureKey = FailureClass | "unknown";

/** La clase de una misión fallida, o `null` si no falló. Un valor desconocido del backend cae a "unknown". Pura. */
export function failureKey(m: Pick<Mission, "status" | "failureClass">): FailureKey | null {
  if (m.status !== "failed") return null;
  const c = m.failureClass;
  return c && (FAILURE_CLASSES as readonly string[]).includes(c) ? c : "unknown";
}

/** Claves i18n de la etiqueta y de la acción sugerida. */
export const failureLabelKey = (k: FailureKey) => `failure.${k}.label`;
export const failureActionKey = (k: FailureKey) => `failure.${k}.action`;
