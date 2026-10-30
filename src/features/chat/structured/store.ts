import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import type { ChatAccess } from "../chatModel";
import { setComposing, useChatStore } from "../store";
import {
  chatRequestAnswer, chatThreadCreate, chatThreadInterrupt, chatThreadItems, chatThreadRequests, chatThreadRetune, chatThreadSend,
  chatThreadSettle, chatThreads, chatThreadStatus, type ThreadRow,
} from "./ipc";
import { applyThreadEvent, EMPTY_LIVE, type ThreadEvent, type ThreadLive } from "./model";

/**
 * As conversas por protocolo, ao vivo: a lista (do banco) e, por conversa aberta, a timeline, os
 * pedidos pendentes e se o agente está trabalhando. Tudo chega pelo evento `cc-chat-thread`; a
 * primeira leitura de cada conversa vem do banco.
 */
interface StructuredState {
  threads: ThreadRow[];
  live: Record<string, ThreadLive>;
  /** As conversas cuja timeline já foi lida do banco. */
  hydrated: Record<string, boolean>;
}

export const useStructured = create<StructuredState>(() => ({ threads: [], live: {}, hydrated: {} }));

const liveOf = (id: string) => useStructured.getState().live[id] ?? EMPTY_LIVE;

function patchLive(id: string, fn: (live: ThreadLive) => ThreadLive): void {
  useStructured.setState((s) => ({ live: { ...s.live, [id]: fn(s.live[id] ?? EMPTY_LIVE) } }));
}

function upsertThread(row: ThreadRow): void {
  useStructured.setState((s) => ({ threads: [row, ...s.threads.filter((t) => t.id !== row.id)] }));
}

export function reloadThreads(): Promise<void> {
  return chatThreads().then((threads) => useStructured.setState({ threads })).catch(() => undefined);
}

let started = false;

/** Liga a escuta (uma vez por janela) e lê a lista. */
export function startStructured(): void {
  if (started) return;
  started = true;
  void reloadThreads();
  void listen<ThreadEvent>("cc-chat-thread", (e) => {
    const event = e.payload;
    if (event.type === "thread") {
      useStructured.setState((s) => ({ threads: s.threads.map((t) => (t.id === event.threadId ? { ...t, title: event.title } : t)) }));
      return;
    }
    patchLive(event.threadId, (live) => applyThreadEvent(live, event));
    if (event.type === "item") {
      useStructured.setState((s) => ({ threads: s.threads.map((t) => (t.id === event.threadId ? { ...t, updatedAt: Date.now() } : t)) }));
    }
  });
}

/** Lê do banco a timeline e os pendentes de uma conversa (uma vez). */
export function hydrateThread(id: string): void {
  if (useStructured.getState().hydrated[id]) return;
  useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [id]: true } }));
  void Promise.all([chatThreadItems(id), chatThreadRequests(id), chatThreadStatus(id)])
    .then(([items, requests, status]) => patchLive(id, (live) => ({
      ...live,
      // O que chegou por evento enquanto lia fica (é mais novo).
      items: [...items.filter((i) => !live.items.some((x) => x.id === i.id)), ...live.items],
      requests: requests.length > 0 ? requests : live.requests,
      phase: status.working ? "working" : live.phase,
    })))
    .catch(() => useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [id]: false } })));
}

/** Mostra uma conversa por protocolo. */
export function openThread(id: string): void {
  useChatStore.setState({ thread: id });
  setComposing(false);
}

export interface NewThread {
  agentId: string;
  cwd: string;
  title: string;
  model: string | null;
  effort: string | null;
  access: ChatAccess;
  accountId: string | null;
}

/** Cria a conversa, mostra e manda a primeira mensagem. */
export async function startThread(input: NewThread, text: string): Promise<string> {
  const row = await chatThreadCreate(input);
  upsertThread(row);
  useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [row.id]: true } }));
  openThread(row.id);
  sendToThread(row.id, text);
  return row.id;
}

/** Manda uma mensagem (começa um turno, ou entra no que está em andamento). */
export function sendToThread(id: string, text: string): void {
  patchLive(id, (live) => ({ ...live, phase: "working", error: null }));
  chatThreadSend(id, text).catch((e) => patchLive(id, (live) => ({ ...live, phase: "idle", error: String(e) })));
}

export function interruptThread(id: string): void {
  chatThreadInterrupt(id).catch((e) => patchLive(id, (live) => ({ ...live, error: String(e) })));
}

export function answerRequest(threadId: string, requestId: string, choice: string): void {
  // Some da tela na hora; se o backend recusar (o agente fechou), o erro aparece.
  patchLive(threadId, (live) => ({ ...live, requests: live.requests.filter((r) => r.id !== requestId) }));
  chatRequestAnswer(requestId, choice).catch((e) => patchLive(threadId, (live) => ({ ...live, error: String(e) })));
}

export function retuneThread(id: string, model: string | null, effort: string | null, access: ChatAccess): void {
  chatThreadRetune(id, model, effort, access)
    .then(upsertThread)
    .catch((e) => patchLive(id, (live) => ({ ...live, error: String(e) })));
}

/** Conclui (o agente fecha; reabrir retoma a mesma thread) ou reabre. */
export function settleThread(id: string, settled: boolean): void {
  useStructured.setState((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, state: settled ? "settled" : "active" } : t)) }));
  if (settled && useChatStore.getState().thread === id) useChatStore.setState({ thread: null });
  chatThreadSettle(id, settled).catch(() => void reloadThreads());
}

export { liveOf };
