import type { Mission } from "./types";

/** Por qué falló una misión (contrato con el clasificador del backend). */
export type FailureCategory = "access" | "limit" | "model" | "crash" | "timeout";

/** `failureClassification` de la misión: la categoría y la clave i18n de la acción sugerida. */
export interface FailureClassification {
  category: FailureCategory;
  actionKey: string;
}

export const FAILURE_CATEGORIES: readonly FailureCategory[] = ["access", "limit", "model", "crash", "timeout"];

/** Sin clasificar (misiones anteriores o falla no reconocida): se muestra como "unknown", sin inventar causa. */
export type FailureKey = FailureCategory | "unknown";

type Failing = Pick<Mission, "status" | "failureClassification">;

/** La categoría de una misión fallida, o `null` si no falló. Una categoría desconocida del backend cae a "unknown". Pura. */
export function failureKey(m: Failing): FailureKey | null {
  if (m.status !== "failed") return null;
  const c = m.failureClassification?.category;
  return c && (FAILURE_CATEGORIES as readonly string[]).includes(c) ? c : "unknown";
}

/** Clave i18n de la etiqueta de una categoría. */
export const failureLabelKey = (k: FailureKey) => `missions.failure.label.${k}`;

/** Clave i18n de la acción sugerida: la que mandó el backend, o la genérica si no vino. Pura. */
export function failureActionKey(m: Failing): string {
  const key = m.failureClassification?.actionKey;
  return key && key.startsWith("missions.failure.action.") ? key : "missions.failure.action.unknown";
}
