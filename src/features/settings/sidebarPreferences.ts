import { useSyncExternalStore } from "react";

/**
 * Configurações → Geral → Barra lateral: a seção Trabalhando. Ligada, as conversas que trabalham ficam numa
 * seção recolhível no fim da lista, e quem precisa de você (aprovação ou pergunta) sobe ao topo. É uma
 * preferência deste aparelho, em `localStorage`. Ligada por padrão, como no T3 Code.
 */
export const WORKING_SHELF_KEY = "cc-sidebar-working-shelf";

const listeners = new Set<() => void>();

/** Lê o valor gravado. Sem nada gravado, ou com lixo, vale ligada. */
export function readWorkingShelf(): boolean {
  try {
    return localStorage.getItem(WORKING_SHELF_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveWorkingShelf(enabled: boolean): void {
  try {
    localStorage.setItem(WORKING_SHELF_KEY, enabled ? "true" : "false");
  } catch {
    // Sem armazenamento, a escolha vale só nesta sessão.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** O valor reativo, para a tela de Configurações e a barra lateral ficarem de acordo. */
export function useWorkingShelf(): boolean {
  return useSyncExternalStore(subscribe, readWorkingShelf, readWorkingShelf);
}
