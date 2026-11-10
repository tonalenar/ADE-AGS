import { conversationTimeline } from "../ipc";
import type { Timeline, TimelineItem } from "./types";
export { searchTimelineItems } from "./searchUtils";
import { searchTimelineItems } from "./searchUtils";

export interface TuiMessageSearchHit {
  tabId: string;
  title: string;
  agentId: string;
  cwd: string;
  itemId: string;
  kind: "user" | "assistant";
  excerpt: string;
}

interface CachedTimeline {
  value: Timeline | null;
  pending?: Promise<Timeline | null>;
}

const CACHE_MAX = 24;
const timelineCache = new Map<string, CachedTimeline>();

/** Lê uma vez a timeline da TUI; as conversas abertas compartilham a leitura durante a busca. */
export function searchableTimeline(tabId: string): Promise<Timeline | null> {
  const cached = timelineCache.get(tabId);
  if (cached?.pending) return cached.pending;
  if (cached) {
    timelineCache.delete(tabId);
    timelineCache.set(tabId, cached);
    return Promise.resolve(cached.value);
  }

  const entry: CachedTimeline = { value: null };
  const pending = conversationTimeline(tabId)
    .then((value) => {
      entry.value = value;
      entry.pending = undefined;
      return value;
    })
    .catch(() => {
      timelineCache.delete(tabId);
      return null;
    });
  entry.pending = pending;
  timelineCache.set(tabId, entry);
  while (timelineCache.size > CACHE_MAX) timelineCache.delete(timelineCache.keys().next().value!);
  return pending;
}

/** Invalida a cópia curta quando o backend avisa que a conversa cresceu. */
export function invalidateSearchableTimeline(tabId: string): void {
  timelineCache.delete(tabId);
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 219).trimEnd()}…` : flat;
}

/** Monta os resultados visíveis para uma conversa TUI ativa. */
export function searchTuiConversation(items: TimelineItem[], query: string, card: { tabId: string; title: string; agentId: string; cwd: string }, limit = 20): TuiMessageSearchHit[] {
  return searchTimelineItems(items, query, limit).flatMap((item) => {
    const text = item.kind === "tool" && item.tool === "todo"
      ? item.plan?.map((step) => step.text).join("\n") ?? ""
      : item.text ?? "";
    return text ? [{
      ...card,
      itemId: item.id,
      kind: item.kind === "user" ? "user" : "assistant",
      excerpt: excerptOf(text),
    }] : [];
  });
}
