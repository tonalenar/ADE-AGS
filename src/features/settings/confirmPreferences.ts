import { useSyncExternalStore } from "react";

/**
 * Confirmações da barra lateral (Configurações → Geral → Confirmações): antes de desafixar, arquivar ou
 * concluir/fechar uma conversa, pedir confirmação. Preferência deste aparelho, em `localStorage`, tolerando
 * lixo. Excluir continua pedindo confirmação por padrão: é a ação que não tem volta.
 */
export const CONFIRM_PREFS_KEY = "cc-confirm-prefs";

export interface ConfirmPrefs {
  /** Pedir confirmação para desafixar uma conversa. */
  unpin: boolean;
  /** Pedir confirmação para arquivar uma conversa. */
  archive: boolean;
  /** Pedir confirmação para excluir (concluir ou fechar) uma conversa. */
  delete: boolean;
}

export const DEFAULT_CONFIRM_PREFS: ConfirmPrefs = { unpin: false, archive: false, delete: true };

/** Lê o que veio (de onde for) e devolve só o que serve; o que não for booleano volta ao padrão. Pura. */
export function parseConfirmPrefs(raw: unknown): ConfirmPrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    unpin: typeof o.unpin === "boolean" ? o.unpin : DEFAULT_CONFIRM_PREFS.unpin,
    archive: typeof o.archive === "boolean" ? o.archive : DEFAULT_CONFIRM_PREFS.archive,
    delete: typeof o.delete === "boolean" ? o.delete : DEFAULT_CONFIRM_PREFS.delete,
  };
}

export function loadConfirmPrefs(): ConfirmPrefs {
  try {
    const raw = localStorage.getItem(CONFIRM_PREFS_KEY);
    return parseConfirmPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_CONFIRM_PREFS };
  }
}

const listeners = new Set<() => void>();
let snapshot: ConfirmPrefs | null = null;

export function saveConfirmPrefs(prefs: ConfirmPrefs): void {
  const next = parseConfirmPrefs(prefs);
  try {
    localStorage.setItem(CONFIRM_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Sem armazenamento, a escolha vale só nesta sessão.
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConfirmPrefs {
  return snapshot ??= loadConfirmPrefs();
}

/** As confirmações, reativas: a tela de Configurações e a barra lateral leem o mesmo valor. */
export function useConfirmPrefs(): ConfirmPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
