import { useSyncExternalStore } from "react";

import { DEFAULT_AUTO_SETTLE, type AutoSettleChoice, parseAutoSettleChoice } from "@/features/chat/sidebar/autoSettle";

/**
 * A escolha de "Concluir sozinho" é uma preferência deste aparelho (`localStorage`), como a seção
 * Trabalhando. Sem nada gravado, ou com lixo, vale desligado.
 */
export const AUTO_SETTLE_KEY = "cc-threads-auto-settle";

const listeners = new Set<() => void>();

export function readAutoSettleChoice(): AutoSettleChoice {
  try {
    return parseAutoSettleChoice(localStorage.getItem(AUTO_SETTLE_KEY));
  } catch {
    return DEFAULT_AUTO_SETTLE;
  }
}

export function saveAutoSettleChoice(choice: AutoSettleChoice): void {
  try {
    localStorage.setItem(AUTO_SETTLE_KEY, choice);
  } catch {
    // Sem armazenamento, a escolha vale só nesta sessão.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === AUTO_SETTLE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** O valor reativo: a página de Configurações e a barra ficam de acordo ao trocar. */
export function useAutoSettleChoice(): AutoSettleChoice {
  return useSyncExternalStore(subscribe, readAutoSettleChoice, readAutoSettleChoice);
}
