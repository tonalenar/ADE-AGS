import { decideAll, reviewFlag, sortReviewItems } from "./review";
import type { MemoryReviewItem } from "./types";

/**
 * Lógica del modal único de sugerencias de memoria (todas las misiones del workspace).
 * Pura salvo `decide`, que se inyecta. La aprobación SIEMPRE nace de un clic del usuario: acá
 * no hay ninguna ruta que apruebe sola, y las contradicciones no se aceptan en masa sin que el
 * usuario haya visto el aviso (`acknowledgeContradictions`).
 */
export interface MissionReviewGroup {
  missionId: string;
  title: string;
  items: MemoryReviewItem[];
}

export const isDeletion = (item: MemoryReviewItem): boolean => item.operation === "delete";

export const itemId = (item: Pick<MemoryReviewItem, "entryId" | "revision">): string => `${item.entryId}:${item.revision}`;

/** Grupos sin items fuera, items ordenados (atención primero) y misiones por título. */
export function normalizeGroups(groups: MissionReviewGroup[]): MissionReviewGroup[] {
  return groups
    .filter((g) => g.items.length > 0)
    .map((g) => ({ ...g, items: sortReviewItems(g.items) }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.missionId.localeCompare(b.missionId));
}

export const flatten = (groups: MissionReviewGroup[]): MemoryReviewItem[] => groups.flatMap((g) => g.items);
export const totalPending = (groups: MissionReviewGroup[]): number => flatten(groups).length;

/** Los items elegidos (por id), en el orden en que se muestran. */
export function selectedItems(groups: MissionReviewGroup[], selected: ReadonlySet<string>): MemoryReviewItem[] {
  return flatten(groups).filter((i) => selected.has(itemId(i)));
}

export interface BulkPlan {
  total: number;
  contradictions: MemoryReviewItem[];
  duplicates: number;
  /** Propuestas de EXCLUSIÓN: borran una memoria aprobada, no agregan una nueva. */
  deletions: MemoryReviewItem[];
  /** Hay que mostrar el aviso de contradicciones antes de aceptar. */
  needsWarning: boolean;
}

/** Qué pasaría al aceptar estos items: cuántos, y cuántos contradicen algo ya aprobado. */
export function planBulk(items: MemoryReviewItem[]): BulkPlan {
  const contradictions = items.filter((i) => reviewFlag(i) === "contradiction");
  return {
    total: items.length,
    contradictions,
    duplicates: items.filter((i) => reviewFlag(i) === "duplicate").length,
    deletions: items.filter(isDeletion),
    needsWarning: contradictions.length > 0 || items.some(isDeletion),
  };
}

export interface BulkOutcome {
  done: number;
  failed: string[];
  /** Contradicciones que NO se aceptaron porque el usuario no confirmó el aviso. */
  skippedContradictions: string[];
  /** Exclusiones que NO se aceptaron por la misma razón. */
  skippedDeletions: string[];
}

/**
 * Acepta en masa. Las contradicciones solo entran con `acknowledgeContradictions: true`
 * (el usuario vio el aviso y confirmó); si no, se saltan y se informan. Igual las exclusiones.
 */
export async function approveBulk(
  items: MemoryReviewItem[],
  decide: (entryId: string, revision: number, approve: boolean) => Promise<void>,
  opts: { acknowledgeContradictions: boolean },
): Promise<BulkOutcome> {
  const skipped = opts.acknowledgeContradictions ? [] : items.filter((i) => reviewFlag(i) === "contradiction" || isDeletion(i));
  const skipSet = new Set(skipped.map(itemId));
  const result = await decideAll(items.filter((i) => !skipSet.has(itemId(i))), true, decide);
  return {
    ...result,
    skippedContradictions: skipped.filter((i) => !isDeletion(i)).map((i) => i.key),
    skippedDeletions: skipped.filter(isDeletion).map((i) => i.key),
  };
}

/** Rechaza en masa (no hay riesgo de contradicción: no se agrega nada a la memoria). */
export async function rejectBulk(
  items: MemoryReviewItem[],
  decide: (entryId: string, revision: number, approve: boolean) => Promise<void>,
): Promise<BulkOutcome> {
  return { ...(await decideAll(items, false, decide)), skippedContradictions: [], skippedDeletions: [] };
}
