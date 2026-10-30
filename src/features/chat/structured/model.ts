import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { PROTOCOL_AGENTS, type ChatAccess, type ConversationCard } from "../chatModel";
import { appendDeltas, type DeltaInput, type Draft, type DraftKind } from "../timeline/streaming";
import type { TimelineItem } from "../timeline/types";
import type { QuestionOption, RequestRow, ThreadAccess, ThreadRow } from "./ipc";

/**
 * As conversas por protocolo (o Codex pelo `app-server`, o Claude Code pelo `claude -p` em
 * stream-json, o OpenCode pelo `opencode acp` e o Antigravity pelo `agy --print`, ver
 * `src-tauri/src/conversa/`) no mesmo formato que as outras: um cartão da sidebar e uma timeline.
 * Puro.
 */

/** Os agentes que conversam por protocolo (espelho de `conversa::structured_agent`; a tabela é `PROTOCOL_AGENTS`). */
export const STRUCTURED_AGENTS = new Set(Object.keys(PROTOCOL_AGENTS));

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
  /** O texto (e o raciocínio) do agente chegando, por item, antes do item completo. */
  drafts: Draft[];
  error: string | null;
}

export const EMPTY_LIVE: ThreadLive = { items: [], requests: [], phase: "idle", drafts: [], error: null };

/** Um evento `cc-chat-thread` (ver `conversa::codex`). */
export type ThreadEvent =
  | { type: "item"; threadId: string; item: TimelineItem }
  /** Um pedaço do texto chegando (só na janela; o banco guarda o item completo). */
  | { type: "delta"; threadId: string; itemId: string; delta: string; kind?: DraftKind }
  | { type: "phase"; threadId: string; phase: "working" | "idle" }
  | { type: "request"; threadId: string; request: RequestRow }
  | { type: "requestResolved"; threadId: string; id: string }
  /** O título mudou, ou o acesso (o Claude saiu do Plano, aceitou edições na sessão). */
  | { type: "thread"; threadId: string; title?: string; access?: ThreadAccess }
  | { type: "error"; threadId: string; message: string }
  | { type: "closed"; threadId: string };

/** O estado ao vivo de uma conversa depois de um evento. Pura. */
export function applyThreadEvent(live: ThreadLive, event: ThreadEvent): ThreadLive {
  switch (event.type) {
    case "item": {
      const at = live.items.findIndex((i) => i.id === event.item.id);
      const items = at >= 0 ? live.items.map((i, k) => (k === at ? event.item : i)) : [...live.items, event.item];
      const drafts = live.drafts.some((d) => d.itemId === event.item.id) ? live.drafts.filter((d) => d.itemId !== event.item.id) : live.drafts;
      return { ...live, items, drafts };
    }
    case "delta":
      return applyDeltas(live, [event]);
    case "phase":
      return { ...live, phase: event.phase, drafts: event.phase === "idle" ? [] : live.drafts, error: event.phase === "working" ? null : live.error };
    case "request":
      return { ...live, requests: [...live.requests.filter((r) => r.id !== event.request.id), event.request] };
    case "requestResolved":
      return { ...live, requests: live.requests.filter((r) => r.id !== event.id) };
    case "error":
      return { ...live, error: event.message };
    case "closed":
      return { ...live, phase: "idle", drafts: [], requests: [] };
    default:
      return live;
  }
}

/** Os pedaços de um quadro de uma vez (o store junta os `delta` por `requestAnimationFrame`). Pura. */
export function applyDeltas(live: ThreadLive, deltas: DeltaInput[]): ThreadLive {
  // Um pedaço de um item que já chegou inteiro (atrasado na fila) não reabre o rascunho.
  const known = new Set(live.items.map((i) => i.id));
  const fresh = deltas.filter((d) => !known.has(d.itemId));
  if (fresh.length === 0) return live;
  return { ...live, drafts: appendDeltas(live.drafts, fresh) };
}

/** A conversa depois de um evento `thread`: só o que veio muda. Pura. */
export function applyThreadMeta(row: ThreadRow, event: { title?: string; access?: ThreadAccess }): ThreadRow {
  return { ...row, ...(event.title ? { title: event.title } : {}), ...(event.access ? { access: event.access } : {}) };
}

/** A pergunta de um pedido (a primeira), ou `null` se o pedido não é pergunta. Pura. */
export function questionOf(request: RequestRow | null): QuestionOption | null {
  if (request?.kind !== "question" || !Array.isArray(request.options)) return null;
  return request.options[0] ?? null;
}

/** O pedido do Claude para sair do Plano (a ferramenta `ExitPlanMode`). Pura. */
export function isPlanExit(request: RequestRow | null): boolean {
  const options = request?.options;
  return !!options && !Array.isArray(options) && options.tool === "ExitPlanMode";
}

/** O Plano ligado ou desligado. Desligar volta a Supervisionado: nunca dá mais permissão do que antes do Plano. Pura. */
export function togglePlan(access: ThreadAccess): ThreadAccess {
  return access === "plan" ? "ask" : "plan";
}

/** O que o menu de acesso mostra: no Plano, o modo em que o agente segue depois (Supervisionado). Pura. */
export function menuAccess(access: ThreadAccess): ChatAccess {
  return access === "plan" ? "ask" : access;
}
