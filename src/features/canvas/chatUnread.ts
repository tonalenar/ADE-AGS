import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { useTabsStore } from "@/features/tabs/store";

/** Lo mínimo de un mensaje para contar: el chat entero vive en `ChatPanel`. */
interface Msg {
  thread: string;
  kind: string;
  at: number;
}

/** Cuántas respuestas del agente (`say`) hay por hilo, más nuevas que lo último visto de ese hilo. */
export function countUnread(messages: Msg[], seenAt: (thread: string) => number | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of messages) {
    if (m.kind !== "say") continue;
    const seen = seenAt(m.thread);
    if (seen !== undefined && m.at <= seen) continue;
    out[m.thread] = (out[m.thread] ?? 0) + 1;
  }
  return out;
}

/** Lo último que llegó a cada hilo (para marcarlo como visto). */
export function latest(messages: Msg[], thread: string): number {
  let at = 0;
  for (const m of messages) if (m.thread === thread && m.at > at) at = m.at;
  return at;
}

const STORE_KEY = "cc.chat.seen";
const keyOf = (tab: string, thread: string) => `${tab}|${thread}`;

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

interface UnreadState {
  /** Hasta cuándo se vio cada (agente, hilo). */
  seen: Record<string, number>;
  /** tabId → hilo → cuántas sin leer. */
  unread: Record<string, Record<string, number>>;
  /** `baseline`: la carga inicial de un agente; lo que ya hay no es "nuevo". Los avisos en vivo cuentan todo. */
  ingest: (tabId: string, messages: Msg[], baseline?: boolean) => void;
  markSeen: (tabId: string, thread: string, messages: Msg[]) => void;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  seen: readSeen(),
  unread: {},

  ingest(tabId, messages, baseline = false) {
    // Un hilo que nunca se vio parte de lo que ya tiene: lo anterior a este seguimiento no es "nuevo".
    const seen = { ...get().seen };
    let touched = false;
    for (const m of messages) {
      const k = keyOf(tabId, m.thread);
      if (baseline && seen[k] === undefined) {
        seen[k] = latest(messages, m.thread);
        touched = true;
      }
    }
    if (touched) persist(seen);
    set((s) => ({
      seen: touched ? seen : s.seen,
      unread: { ...s.unread, [tabId]: countUnread(messages, (th) => seen[keyOf(tabId, th)]) },
    }));
  },

  markSeen(tabId, thread, messages) {
    const at = latest(messages, thread);
    const k = keyOf(tabId, thread);
    const seen = get().seen;
    if (at <= (seen[k] ?? 0) && !get().unread[tabId]?.[thread]) return;
    const next = { ...seen, [k]: Math.max(at, seen[k] ?? 0) };
    persist(next);
    set((s) => ({
      seen: next,
      unread: { ...s.unread, [tabId]: { ...s.unread[tabId], [thread]: 0 } },
    }));
  },
}));

function persist(seen: Record<string, number>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(seen));
  } catch {
    /* sin almacenamiento: se pierde solo la marca de "visto" */
  }
}

/** Total sin leer de un agente, sumando sus hilos. */
export const unreadOf = (byThread: Record<string, number> | undefined) =>
  byThread ? Object.values(byThread).reduce((a, b) => a + b, 0) : 0;

/**
 * Mantiene al día los no leídos de todos los agentes con chat: al montar y cada vez que el
 * backend avisa de un cambio. Va en la barra del canvas, que siempre está montada.
 */
export function useChatUnreadWatcher() {
  const agentIds = useTabsStore((s) => s.tabs.filter((t) => t.agentId !== "bash").map((t) => t.id).join(","));
  useEffect(() => {
    const ingest = (tabId: string, baseline: boolean) =>
      invoke<{ messages: Msg[] }>("chat_history", { tabId })
        .then((c) => useUnreadStore.getState().ingest(tabId, c.messages, baseline))
        .catch(() => undefined);
    for (const id of agentIds.split(",").filter(Boolean)) void ingest(id, true);
    const off = listen<string>("cc-chat-changed", (e) => void ingest(e.payload, false));
    return () => {
      off.then((fn) => fn());
    };
  }, [agentIds]);
}
