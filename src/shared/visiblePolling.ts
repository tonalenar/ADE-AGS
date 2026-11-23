/** Resultado de um tick de polling, usado para calcular backoff quando a operação demora ou falha. */
export interface PollOutcome {
  elapsedMs: number;
  failed: boolean;
  /** Quantos ticks seguidos falharam ou demoraram (0 após sucesso rápido). */
  streak: number;
}

export type PollDelay = number | ((outcome: PollOutcome) => number);

export interface VisiblePollHandle {
  stop: () => void;
  /** Dispara uma leitura imediata se a janela estiver visível (ou agenda assim que a atual terminar). */
  trigger: () => void;
}

export function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Executa `run` periodicamente só enquanto a janela está visível, com single-flight:
 * - pausa imediatamente quando `document.visibilityState === "hidden"`;
 * - ao voltar para `"visible"`, faz uma leitura imediata e retoma o ciclo;
 * - nunca sobrepõe execuções: o próximo prazo só conta após a chamada anterior terminar.
 */
export function startVisiblePolling(
  run: () => void | Promise<unknown>,
  delay: PollDelay,
  options?: { immediate?: boolean; isSlow?: (elapsedMs: number) => boolean },
): VisiblePollHandle {
  const immediate = options?.immediate ?? true;
  const isSlow = options?.isSlow ?? (() => false);

  let stopped = false;
  let inFlight = false;
  let rerun = false;
  let streak = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const nextMs = (outcome: PollOutcome): number =>
    typeof delay === "function" ? delay(outcome) : delay;

  const schedule = (ms: number) => {
    clearTimer();
    if (stopped || isDocumentHidden()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, Math.max(0, ms));
  };

  const tick = async () => {
    if (stopped || isDocumentHidden()) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    clearTimer();
    inFlight = true;
    const started = Date.now();
    let failed = false;
    try {
      await run();
    } catch {
      failed = true;
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    const elapsedMs = Math.max(0, Date.now() - started);
    if (failed || isSlow(elapsedMs)) {
      streak += 1;
    } else {
      streak = 0;
    }
    if (rerun && !isDocumentHidden()) {
      rerun = false;
      void tick();
      return;
    }
    rerun = false;
    schedule(nextMs({ elapsedMs, failed, streak }));
  };

  const onVisibility = () => {
    if (stopped) return;
    if (isDocumentHidden()) {
      clearTimer();
      rerun = false;
      return;
    }
    void tick();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  if (!isDocumentHidden()) {
    if (immediate) {
      void tick();
    } else {
      schedule(nextMs({ elapsedMs: 0, failed: false, streak: 0 }));
    }
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      rerun = false;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    },
    trigger: () => {
      if (stopped || isDocumentHidden()) return;
      void tick();
    },
  };
}
