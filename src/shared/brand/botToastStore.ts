import { create } from "zustand";

export type BotToastTone = "info" | "warning" | "error";

export interface BotToast {
  id: number;
  title: string;
  text: string;
  tone: BotToastTone;
  /** Texto del botón de acción; sin él, el aviso no tiene botón. */
  actionLabel?: string;
  onAction?: () => void;
  /** Cuánto dura en pantalla, en milisegundos. */
  ms: number;
  /** Se queda hasta que alguien lo cierre o lo reemplace (un trabajo en curso). Ignora `ms`. */
  sticky?: boolean;
  /** Barra de progreso: 0–100, o `null` si no se sabe cuánto falta. Sin el campo, no hay barra. */
  progress?: number | null;
}

export type BotToastInput = Omit<BotToast, "id" | "ms" | "tone"> & { tone?: BotToastTone; ms?: number };

/** Cuántos avisos se ven a la vez: el más viejo cede su lugar al nuevo. */
export const MAX_BOT_TOASTS = 3;
export const DEFAULT_BOT_TOAST_MS = 8000;

interface BotToastState {
  toasts: BotToast[];
  push: (input: BotToastInput) => number;
  dismiss: (id: number) => void;
  /** Cambia un aviso que sigue en pantalla (el texto o el progreso de un trabajo en curso). */
  update: (id: number, patch: Partial<Pick<BotToast, "title" | "text" | "tone" | "progress">>) => void;
}

let nextId = 1;

export const useBotToastStore = create<BotToastState>((set) => ({
  toasts: [],
  push(input) {
    const id = nextId++;
    const toast: BotToast = { ...input, id, tone: input.tone ?? "info", ms: input.ms ?? DEFAULT_BOT_TOAST_MS };
    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_BOT_TOASTS) }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  update: (id, patch) => set((state) => ({ toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)) })),
}));

/** Un aviso con el bot dentro del globo (ver `BotToastHost`). Se puede llamar desde cualquier lado. */
export function showBotToast(input: BotToastInput): number {
  return useBotToastStore.getState().push(input);
}
