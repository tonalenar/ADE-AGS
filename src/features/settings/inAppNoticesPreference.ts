import { useSyncExternalStore } from "react";

/**
 * "Notificações no app": o aviso no canto quando outra conversa termina, falha ou pede aprovação ou
 * resposta, com a janela em foco. É uma preferência deste aparelho, então vai ao `localStorage`.
 * Desligado por padrão, como no T3 Code (lá, "In-app notifications" começa desligado).
 */
export const IN_APP_NOTICES_KEY = "cc-in-app-notices";

const listeners = new Set<() => void>();

/** Lê o valor gravado. Sem nada gravado, ou com lixo, vale desligado. */
export function readInAppNotices(): boolean {
  try {
    return localStorage.getItem(IN_APP_NOTICES_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveInAppNotices(enabled: boolean): void {
  try {
    localStorage.setItem(IN_APP_NOTICES_KEY, enabled ? "true" : "false");
  } catch {
    // Sem armazenamento, a escolha vale só nesta sessão.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** O valor reativo, para a tela de Configurações e o ouvinte de avisos ficarem de acordo. */
export function useInAppNotices(): boolean {
  return useSyncExternalStore(subscribe, readInAppNotices, readInAppNotices);
}
