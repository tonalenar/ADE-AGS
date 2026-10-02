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

/**
 * ¿Hay que sonar? Cuando algún hilo tiene más respuestas sin leer que antes y no es el que
 * se está mirando (lo que está a la vista se lee solo, no hace falta avisar).
 */
export function shouldChime(
  prev: Record<string, number> | undefined,
  next: Record<string, number>,
  viewing: string | null,
): boolean {
  return Object.entries(next).some(([thread, n]) => thread !== viewing && n > (prev?.[thread] ?? 0));
}

/** Un "ding" corto de dos notas, sin archivo de audio. Si el audio no está disponible, no pasa nada. */
export function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t0 = ctx.currentTime;
    [[880, 0], [1318.5, 0.11]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.34);
    });
    window.setTimeout(() => void ctx.close(), 800);
  } catch {
    /* sin audio: el globo rojo basta */
  }
}

const SOUND_KEY = "cc.chat.sound";
export const readSound = (): boolean => {
  try {
    return localStorage.getItem(SOUND_KEY) !== "0";
  } catch {
    return true;
  }
};
export const writeSound = (on: boolean) => {
  try {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    /* no se recuerda */
  }
};

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
  /** Qué (agente, hilo) está a la vista en el panel de chat: ahí no se suena. */
  viewing: { tabId: string; thread: string } | null;
  sound: boolean;
  setViewing: (v: { tabId: string; thread: string } | null) => void;
  setSound: (on: boolean) => void;
  /** `baseline`: la carga inicial de un agente; lo que ya hay no es "nuevo". Los avisos en vivo cuentan todo. */
  ingest: (tabId: string, messages: Msg[], baseline?: boolean) => void;
  markSeen: (tabId: string, thread: string, messages: Msg[]) => void;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  seen: readSeen(),
  unread: {},
  viewing: null,
  sound: readSound(),
  setViewing: (viewing) => set({ viewing }),
  setSound: (sound) => {
    writeSound(sound);
    set({ sound });
  },

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
    const next = countUnread(messages, (th) => seen[keyOf(tabId, th)]);
    const { viewing, sound, unread } = get();
    if (!baseline && sound && shouldChime(unread[tabId], next, viewing?.tabId === tabId ? viewing.thread : null)) chime();
    set((s) => ({
      seen: touched ? seen : s.seen,
      unread: { ...s.unread, [tabId]: next },
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
