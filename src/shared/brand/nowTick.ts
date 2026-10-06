import { useSyncExternalStore } from "react";

/**
 * Um relógio compartilhado e preguiçoso: um único intervalo para o app inteiro, que só existe
 * enquanto há quem escute (nada de timer por instância) e que não corre com a janela oculta.
 * Serve ao mascote para perceber "faz tempo que nada acontece" sem consultar o relógio a cada
 * render.
 */
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let timer: number | undefined;
let now = Date.now();

function tick() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  now = Date.now();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** A hora, atualizada a cada 30s (e ao voltar a janela, no próximo tique). */
export function useNowTick(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
