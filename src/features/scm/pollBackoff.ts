export const SCM_POLL_BASE_MS = 4000;
export const SCM_POLL_SLOW_MS = 1500;
export const SCM_POLL_MAX_MS = 30_000;

/**
 * Intervalo até a próxima leitura do `scm_status`:
 * - normal: 4 s;
 * - se o git demorou (>= 1,5 s) ou falhou: aplica backoff exponencial até 30 s
 *   (e pelo menos 3× a duração medida) para aliviar CPU/disco sob carga.
 */
export function nextScmPollMs(info: { elapsedMs: number; failed: boolean; streak: number }): number {
  const { elapsedMs, failed, streak } = info;
  if (!failed && elapsedMs < SCM_POLL_SLOW_MS) return SCM_POLL_BASE_MS;
  const step = Math.max(1, streak);
  const exp = SCM_POLL_BASE_MS * 2 ** Math.min(step, 3);
  const proportional = elapsedMs >= SCM_POLL_SLOW_MS ? Math.round(elapsedMs * 3) : 0;
  return Math.min(SCM_POLL_MAX_MS, Math.max(exp, proportional));
}
