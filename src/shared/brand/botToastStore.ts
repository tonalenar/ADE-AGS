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
  /** A ação pode ser chamada por `thread.undo` enquanto este aviso estiver visível. */
  undoable?: boolean;
  /** Permanece até uma dispensa explícita; ignora `ms` e a poda de avisos transitórios. */
  sticky?: boolean;
  /** Barra de progreso: 0–100, o `null` si no se sabe cuánto falta. Sin el campo, no hay barra. */
  progress?: number | null;
}

export type BotToastInput = Omit<BotToast, "id" | "ms" | "tone"> & { tone?: BotToastTone; ms?: number };

/** Cuántos avisos transitórios se conservan a la vez; los fijos no se expulsan. */
export const MAX_BOT_TOASTS = 3;
export const DEFAULT_BOT_TOAST_MS = 8000;

interface BotToastState {
  toasts: BotToast[];
  push: (input: BotToastInput) => number;
  dismiss: (id: number) => void;
  /** Cambia un aviso que sigue en pantalla (el texto o el progreso de un trabajo en curso). */
  update: (id: number, patch: Partial<Pick<BotToast, "title" | "text" | "tone" | "progress">>) => void;
  /** Desfaz a ação reversível mais recente ainda visível e fecha seu aviso. */
  undoLatest: () => boolean;
}

let nextId = 1;

export const useBotToastStore = create<BotToastState>((set, get) => ({
  toasts: [],
  push(input) {
    const id = nextId++;
    const toast: BotToast = { ...input, id, tone: input.tone ?? "info", ms: input.ms ?? DEFAULT_BOT_TOAST_MS };
    set((state) => {
      const toasts = [...state.toasts, toast];
      // Avisos fixos (por exemplo, atualizações de agentes) só saem por ação da pessoa.
      // Limite os avisos transitórios sem expulsar um aviso fixo da fila.
      while (toasts.length > MAX_BOT_TOASTS) {
        const oldestTransient = toasts.findIndex((item) => !item.sticky);
        if (oldestTransient < 0) break;
        toasts.splice(oldestTransient, 1);
      }
      return { toasts };
    });
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  update: (id, patch) => set((state) => ({ toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)) })),
  undoLatest: () => {
    const toast = [...get().toasts].reverse().find((item) => item.undoable && item.onAction);
    if (!toast?.onAction) return false;
    try {
      toast.onAction();
    } catch {
      return false;
    }
    get().dismiss(toast.id);
    return true;
  },
}));

/** Un aviso con el bot dentro del globo (ver `BotToastHost`). Se puede llamar desde cualquier lado. */
export function showBotToast(input: BotToastInput): number {
  return useBotToastStore.getState().push(input);
}
