/**
 * A regra da tela cheia do app MCP (como no T3 Code): o app só abre em tela cheia logo depois de um clique
 * dentro dele, e um clique ou tecla em outro lugar da ADE nos 5 s anteriores invalida o pedido. Sem React e
 * sem relógio próprio: `now` entra de fora, para o teste não esperar tempo de verdade.
 */

/** Quanto tempo antes de um clique no app uma atividade fora dele ainda o invalida. */
export const FULLSCREEN_GUARD_MS = 5_000;
/** Quanto o clique no app vale para o pedido de tela cheia que vem depois dele. */
export const FULLSCREEN_GESTURE_TTL_MS = 2_000;

export interface FullscreenGuard {
  /** Clique ou tecla em qualquer outro lugar da ADE. Invalida também um clique no app que ainda esperava o pedido. */
  outside(): void;
  /** Clique dentro do app. Não conta se houve atividade fora nos {@link FULLSCREEN_GUARD_MS} anteriores. */
  gesture(): void;
  /** O pedido de tela cheia vale agora? Consome o clique: um clique abre uma vez. */
  consume(): boolean;
}

export function createFullscreenGuard(now: () => number = Date.now): FullscreenGuard {
  let outsideAt = Number.NEGATIVE_INFINITY;
  let gestureAt: number | null = null;
  return {
    outside() {
      outsideAt = now();
      gestureAt = null;
    },
    gesture() {
      const at = now();
      gestureAt = at - outsideAt < FULLSCREEN_GUARD_MS ? null : at;
    },
    consume() {
      const at = gestureAt;
      gestureAt = null;
      if (at === null) return false;
      return now() - at <= FULLSCREEN_GESTURE_TTL_MS;
    },
  };
}
