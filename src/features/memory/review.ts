import type { MemoryReviewItem } from "./types";

export const HIGH_VALUE_SCORE = 70;

export type ReviewFlag = "contradiction" | "duplicate" | "highValue" | "normal";

/** Marca principal do item: contradição pesa mais que duplicata, que pesa mais que valor. Pura. */
export function reviewFlag(item: MemoryReviewItem): ReviewFlag {
  if (item.contradicts) return "contradiction";
  if (item.duplicateOf) return "duplicate";
  if (item.highValue || item.score >= HIGH_VALUE_SCORE) return "highValue";
  return "normal";
}

const FLAG_ORDER: Record<ReviewFlag, number> = { contradiction: 0, highValue: 1, normal: 2, duplicate: 3 };

/** Atenção primeiro: contradições, depois as de maior valor (por score), normais e duplicatas no fim. Pura. */
export function sortReviewItems(items: MemoryReviewItem[]): MemoryReviewItem[] {
  return [...items].sort(
    (a, b) => FLAG_ORDER[reviewFlag(a)] - FLAG_ORDER[reviewFlag(b)] || b.score - a.score || a.key.localeCompare(b.key),
  );
}

export interface BatchResult {
  done: number;
  failed: string[];
}

/** Decide um a um (sempre pedido do usuário); um erro não interrompe os outros. */
export async function decideAll(
  items: MemoryReviewItem[],
  approve: boolean,
  decide: (entryId: string, revision: number, approve: boolean) => Promise<void>,
): Promise<BatchResult> {
  const result: BatchResult = { done: 0, failed: [] };
  for (const item of items) {
    try {
      await decide(item.entryId, item.revision, approve);
      result.done += 1;
    } catch {
      result.failed.push(item.key);
    }
  }
  return result;
}

/** Texto de evidência curto, sem inventar: só o que o backend mandou. Pura. */
export function evidenceParts(item: MemoryReviewItem): { runId?: string; taskId?: string; factId?: string; reason?: string } {
  const e = item.evidence;
  const out: { runId?: string; taskId?: string; factId?: string; reason?: string } = {};
  if (e.runId) out.runId = e.runId;
  if (e.taskId) out.taskId = e.taskId;
  if (e.factId) out.factId = e.factId;
  if (e.reason) out.reason = e.reason;
  return out;
}

export interface ReviewMark {
  kind: "duplicate" | "contradiction";
  key: string;
}

/** TODAS as marcas do item, não só a principal: uma entrada pode ser duplicata e contradição. Pura. */
export function reviewMarks(item: MemoryReviewItem): ReviewMark[] {
  const marks: ReviewMark[] = [];
  if (item.duplicateOf) marks.push({ kind: "duplicate", key: item.duplicateOf.key });
  if (item.contradicts) marks.push({ kind: "contradiction", key: item.contradicts.key });
  return marks;
}
