import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import type { ConversationCard } from "../chatModel";
import type { TimelineItem } from "../timeline/types";
import type { RequestRow, ThreadRow } from "./ipc";

/**
 * As conversas por protocolo (o Codex pelo `app-server`, ver `src-tauri/src/conversa/`) no mesmo
 * formato que as outras: um cartão da sidebar e uma timeline. Puro.
 */

/** Os agentes que conversam por protocolo (espelho de `conversa::structured_agent`). */
export const STRUCTURED_AGENTS = new Set(["codex"]);

/** O prefixo que separa um cartão de conversa por protocolo de um de aba (o `tabId` do cartão). */
export const THREAD_PREFIX = "thread:";

export const threadKey = (threadId: string) => `${THREAD_PREFIX}${threadId}`;

export function threadIdOf(key: string): string | null {
  return key.startsWith(THREAD_PREFIX) ? key.slice(THREAD_PREFIX.length) : null;
}

/** O nome da pasta, como o painel de workspaces mostra. */
export function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** Os cartões das conversas por protocolo ativas. Branch e worktree saem do painel, quando a pasta está nele. */
export function threadCards(threads: ThreadRow[], groups: RepoGroup[], labelOf: (agentId: string) => string, selected: string | null): ConversationCard[] {
  const byCwd = new Map(groups.flatMap((g) => g.workspaces).map((w) => [w.cwd, w]));
  return threads.filter((t) => t.state === "active").map((t) => {
    const ws = byCwd.get(t.cwd);
    return {
      tabId: threadKey(t.id),
      title: t.title,
      project: ws?.title ?? folderName(t.cwd),
      cwd: t.cwd,
      branch: ws?.branch ?? null,
      isWorktree: ws?.isWorktree ?? false,
      agentId: t.agentId,
      agentLabel: labelOf(t.agentId),
      starting: false,
      active: t.id === selected,
      openedAt: t.updatedAt,
    };
  });
}

export interface ThreadLive {
  items: TimelineItem[];
  requests: RequestRow[];
  phase: "working" | "idle";
  /** O texto do agente chegando, antes do item completo. */
  draft: { itemId: string; text: string } | null;
  error: string | null;
}

export const EMPTY_LIVE: ThreadLive = { items: [], requests: [], phase: "idle", draft: null, error: null };

/** Um evento `cc-chat-thread` (ver `conversa::codex`). */
export type ThreadEvent =
  | { type: "item"; threadId: string; item: TimelineItem }
  | { type: "delta"; threadId: string; itemId: string; delta: string }
  | { type: "phase"; threadId: string; phase: "working" | "idle" }
  | { type: "request"; threadId: string; request: RequestRow }
  | { type: "requestResolved"; threadId: string; id: string }
  | { type: "thread"; threadId: string; title: string }
  | { type: "error"; threadId: string; message: string }
  | { type: "closed"; threadId: string };

/** O estado ao vivo de uma conversa depois de um evento. Pura. */
export function applyThreadEvent(live: ThreadLive, event: ThreadEvent): ThreadLive {
  switch (event.type) {
    case "item": {
      const at = live.items.findIndex((i) => i.id === event.item.id);
      const items = at >= 0 ? live.items.map((i, k) => (k === at ? event.item : i)) : [...live.items, event.item];
      const draft = live.draft?.itemId === event.item.id ? null : live.draft;
      return { ...live, items, draft };
    }
    case "delta": {
      const text = live.draft?.itemId === event.itemId ? live.draft.text + event.delta : event.delta;
      return { ...live, draft: { itemId: event.itemId, text } };
    }
    case "phase":
      return { ...live, phase: event.phase, draft: event.phase === "idle" ? null : live.draft, error: event.phase === "working" ? null : live.error };
    case "request":
      return { ...live, requests: [...live.requests.filter((r) => r.id !== event.request.id), event.request] };
    case "requestResolved":
      return { ...live, requests: live.requests.filter((r) => r.id !== event.id) };
    case "error":
      return { ...live, error: event.message };
    case "closed":
      return { ...live, phase: "idle", draft: null, requests: [] };
    default:
      return live;
  }
}
