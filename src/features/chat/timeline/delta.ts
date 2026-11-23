import type { Timeline, TimelineItem } from "./types";

/** O que o backend devolve em `conversation_timeline_since` (`canal/timeline_cache.rs`): troque `items[from..]` por `items`. */
export interface TimelineDelta {
  rev: number;
  truncated: boolean;
  total: number;
  from: number;
  items: TimelineItem[];
}

/** O que o front já tem, para o backend mandar só a cauda. */
export interface TimelineKnown {
  rev: number;
  count: number;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Aplica a cauda ao que se tinha. Itens que não mudaram mantêm o objeto de antes (o `memo` e o cache do
 * Markdown dependem da identidade), e uma resposta sem mudança devolve o próprio `prev`. `null` = a cauda não
 * encaixa no que se tinha (pediu-se de um ponto que o front não tem): peça a timeline inteira de novo.
 */
export function applyTimelineDelta(prev: Timeline | null, delta: TimelineDelta): Timeline | null {
  const old = prev?.items ?? [];
  if (delta.from > old.length || delta.from + delta.items.length !== delta.total) return null;
  let changed = old.length !== delta.total || (prev?.truncated ?? false) !== delta.truncated;
  const tail = delta.items.map((item, i) => {
    const before = old[delta.from + i];
    if (before && deepEqual(before, item)) return before;
    changed = true;
    return item;
  });
  if (!changed && prev) return prev;
  return { items: [...old.slice(0, delta.from), ...tail], truncated: delta.truncated };
}
