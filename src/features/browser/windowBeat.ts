/**
 * Batimento do renderizador (plano v2, Fase 0.1, achado I1). Um temporizador curto mede o atraso do laço de eventos da UI
 * (`lag` = atraso real − esperado) e guarda num anel dos últimos minutos, com a visibilidade da janela. O relatório do `act`
 * diz o pior atraso durante a execução; o backend recebe o último batimento (1/s) para explicar um timeout do puente.
 * Só mede: não muda nenhum comportamento do piloto.
 */
import { invoke } from "@tauri-apps/api/core";

export const BEAT_MS = 100;
/** Cinco minutos de amostras a 100 ms. */
export const RING_SIZE = 3000;
const REPORT_MS = 1000;

export interface Beat { t: number; lag: number; hidden: boolean }

/** O que o `act` leva no campo `window`. */
export interface WindowStats {
  lagMaxMs: number;
  lagP95Ms: number;
  samples: number;
  hiddenMs: number;
  timeouts: number;
}

/** Percentil (método do posto mais próximo) de valores já ordenados ou não; vazio dá 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Estatística das amostras com `since <= t <= until`. Cada amostra de janela oculta soma o intervalo de batimento em `hiddenMs`. */
export function statsBetween(beats: Beat[], since: number, until: number, timeouts = 0): WindowStats {
  const inside = beats.filter((b) => b.t >= since && b.t <= until);
  const lags = inside.map((b) => b.lag);
  return {
    lagMaxMs: lags.length ? Math.round(Math.max(...lags)) : 0,
    lagP95Ms: Math.round(percentile(lags, 95)),
    samples: inside.length,
    hiddenMs: inside.filter((b) => b.hidden).length * BEAT_MS,
    timeouts,
  };
}

/** Anel de tamanho fixo: o mais antigo sai quando enche. */
export class Ring {
  private items: Beat[] = [];
  constructor(private readonly size = RING_SIZE) {}
  push(beat: Beat): void {
    this.items.push(beat);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }
  all(): Beat[] { return this.items; }
}

/** A linha que o relatório mostra ao agente. */
export function windowLine(w: WindowStats): string {
  const hidden = w.hiddenMs > 0 ? `, oculta ${w.hiddenMs} ms` : "";
  const timeouts = w.timeouts > 0 ? `, ${w.timeouts} timeout(s) do puente` : "";
  return `janela: lag máx ${w.lagMaxMs} ms (p95 ${w.lagP95Ms} ms)${hidden}${timeouts}`;
}

const ring = new Ring();
let timeoutsTotal = 0;
let started = false;

/** Liga o batimento (uma vez por janela). Devolve a função para desligar. */
export function startWindowBeat(): () => void {
  if (started || typeof document === "undefined") return () => {};
  started = true;
  let last = performance.now();
  let maxSinceReport = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - last - BEAT_MS);
    last = now;
    maxSinceReport = Math.max(maxSinceReport, lag);
    ring.push({ t: Date.now(), lag, hidden: document.hidden });
  }, BEAT_MS);
  const report = setInterval(() => {
    const lagMs = Math.round(maxSinceReport);
    maxSinceReport = 0;
    invoke<number>("ui_heartbeat", { lagMs, hidden: document.hidden })
      .then((n) => { if (typeof n === "number") timeoutsTotal = n; })
      .catch(() => {});
  }, REPORT_MS);
  return () => { clearInterval(tick); clearInterval(report); started = false; };
}

/** Marca o começo de um `act`: devolve a função que fecha a medida. */
export function beginWindowMeasure(): () => Promise<WindowStats> {
  const since = Date.now();
  const timeoutsAtStart = timeoutsTotal;
  return async () => {
    // Pergunta o contador na hora (o batimento só o atualiza a cada segundo).
    try {
      const n = await invoke<number>("ui_heartbeat", { lagMs: null, hidden: document.hidden });
      if (typeof n === "number") timeoutsTotal = n;
    } catch { /* sem backend (teste): usa o último conhecido */ }
    return statsBetween(ring.all(), since, Date.now(), Math.max(0, timeoutsTotal - timeoutsAtStart));
  };
}
