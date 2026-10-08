/** Maior rodada de correção registrada na telemetria (`n=` no detalhe do span). */
export function maxFixRound(spans: { kind: string; detail: string }[]): number | null {
  let max: number | null = null;
  for (const span of spans) {
    if (span.kind !== "fix_round") continue;
    const raw = span.detail.split(";").find((part) => part.startsWith("n="))?.slice(2);
    const n = raw == null ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) continue;
    max = max == null ? n : Math.max(max, n);
  }
  return max;
}

/** Texto curto da rodada na tarjeta. A última leva o gate completo. */
export function fixRoundCaption(round: number, fullGate: boolean): string {
  return fullGate ? `correção ${round} · gate completo` : `correção ${round}`;
}
