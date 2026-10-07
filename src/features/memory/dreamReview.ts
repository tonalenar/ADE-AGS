import { approveBulk, type BulkOutcome } from "./bulkReview";
import type { MemoryDream } from "./types";

/** Texto exato que o usuário deve digitar para confirmar um purge (a chave da entrada). Pura. */
export const purgeConfirmed = (typed: string, key: string): boolean => key.length > 0 && typed.trim() === key;

/** Sonhos prontos com algo a revisar, mais recentes primeiro. Pura. */
export function reviewableDreams(dreams: MemoryDream[]): MemoryDream[] {
  return dreams.filter((d) => d.status === "done" && d.proposals.length > 0).sort((a, b) => b.createdAt - a.createdAt);
}

/** Linhas do diff por tipo (para colorir): adicionada, removida ou contexto. Pura. */
export function diffLines(diff: string): { kind: "add" | "del" | "ctx"; text: string }[] {
  return diff.split("\n").filter((l, i, a) => !(l === "" && i === a.length - 1)).map((text) => ({
    kind: text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "del" : "ctx",
    text,
  }));
}

/** Aprovar o grupo = decidir uma a uma pelas MESMAS regras da A3 (sem avisos aceitos, sem duplicatas). */
export const approveDream = (
  dream: MemoryDream,
  decide: (entryId: string, revision: number, approve: boolean, acknowledgeSecret?: boolean) => Promise<unknown>,
): Promise<BulkOutcome> => approveBulk(dream.proposals, decide, { acknowledgeContradictions: false });
