import type { MemoryEntry, MemoryFilter, MemoryKind } from "./types";

export type StatusFilter = "all" | "pending" | "approved" | "rejected";
export type MarksFilter = "all" | "duplicate" | "contradiction" | "both";

export interface SearchState {
  query: string;
  kind: MemoryKind | "all";
  status: StatusFilter;
  marks: MarksFilter;
  expired: boolean;
}

export const EMPTY_SEARCH: SearchState = { query: "", kind: "all", status: "all", marks: "all", expired: false };

export const MEMORY_KINDS: MemoryKind[] = ["decision", "finding", "file", "constraint", "note"];

/** Converte o estado da tela no filtro do backend; o que está em "todos" fica fora (não filtra). */
export function toFilter(s: SearchState): MemoryFilter {
  const f: MemoryFilter = {};
  const q = s.query.trim();
  if (q) f.query = q;
  if (s.kind !== "all") f.kind = s.kind;
  if (s.status !== "all") f.status = s.status;
  if (s.marks === "duplicate" || s.marks === "both") f.duplicateOf = true;
  if (s.marks === "contradiction" || s.marks === "both") f.contradicts = true;
  if (s.expired) f.verificationExpired = true;
  return f;
}

export const isEmptySearch = (s: SearchState): boolean => Object.keys(toFilter(s)).length === 0;

export type Verification =
  | { state: "none" }
  | { state: "never"; ttlDays: number }
  | { state: "ok" | "expired"; ttlDays: number | null; daysAgo: number };

const DAY = 86_400;

/**
 * Situação de verificação da entrada, sem inventar: sem TTL nunca vence; com TTL e sem
 * `lastVerified` conta como vencida (igual ao filtro do backend). `nowSec` em segundos.
 */
export function verificationOf(e: Pick<MemoryEntry, "lastVerified" | "ttlDays">, nowSec: number): Verification {
  const ttl = typeof e.ttlDays === "number" && e.ttlDays > 0 ? e.ttlDays : null;
  const last = typeof e.lastVerified === "number" ? e.lastVerified : null;
  if (last === null) return ttl === null ? { state: "none" } : { state: "never", ttlDays: ttl };
  const daysAgo = Math.max(0, Math.floor((nowSec - last) / DAY));
  const expired = ttl !== null && last <= nowSec - ttl * DAY;
  return { state: expired ? "expired" : "ok", ttlDays: ttl, daysAgo };
}
