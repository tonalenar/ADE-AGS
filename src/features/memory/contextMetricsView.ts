import { invoke } from "@tauri-apps/api/core";

import { formatBytes, reductionPercent } from "./contextMetrics";

/** Linha de `memory_context_metrics` (um Run com snapshot de memória selado). */
export interface RunContextMetric {
  runId: string;
  beforeBytes: number;
  afterBytes: number;
  tokensBefore: number;
  tokensAfter: number;
  commit: string | null;
  entriesUsed: number;
  /** Runs antigos só guardaram o texto final: não há "antes" real para comparar. */
  legacyContext?: boolean;
}

export const getMissionContextMetrics = (missionId: string) =>
  invoke<{ runs: RunContextMetric[] }>("memory_context_metrics", { runId: null, missionId });

/** Medida de cada lado (antes/depois). `null` = sem medição, nunca zero inventado. */
export interface ContextRow {
  runId: string;
  shortId: string;
  beforeBytes: number | null;
  afterBytes: number | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
  reduction: number | null;
  entriesUsed: number;
  legacy: boolean;
}

export interface ContextTotal {
  beforeBytes: number;
  afterBytes: number;
  tokensBefore: number;
  tokensAfter: number;
  reduction: number;
  runs: number;
}

export interface ContextSummary {
  rows: ContextRow[];
  /** Soma só dos Runs com comparação antes/depois real; `null` se nenhum tem. */
  total: ContextTotal | null;
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Um lado em 0 é ausência de medição, não medida: vira `null`. */
export function toRow(m: RunContextMetric): ContextRow {
  const legacy = m.legacyContext === true;
  const hasAfter = positive(m.afterBytes);
  const hasBefore = !legacy && positive(m.beforeBytes);
  return {
    runId: String(m.runId),
    shortId: String(m.runId).slice(0, 8),
    beforeBytes: hasBefore ? m.beforeBytes : null,
    afterBytes: hasAfter ? m.afterBytes : null,
    tokensBefore: hasBefore && positive(m.tokensBefore) ? m.tokensBefore : null,
    tokensAfter: hasAfter && positive(m.tokensAfter) ? m.tokensAfter : null,
    reduction: hasBefore && hasAfter ? reductionPercent(m.beforeBytes, m.afterBytes) : null,
    entriesUsed: typeof m.entriesUsed === "number" && m.entriesUsed >= 0 ? m.entriesUsed : 0,
    legacy,
  };
}

export function summarize(runs: RunContextMetric[] | null | undefined): ContextSummary {
  const rows = (runs ?? []).map(toRow);
  const comparable = rows.filter((r) => r.beforeBytes !== null && r.afterBytes !== null);
  if (comparable.length === 0) return { rows, total: null };
  const sum = (pick: (r: ContextRow) => number | null) => comparable.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
  const beforeBytes = sum((r) => r.beforeBytes);
  const afterBytes = sum((r) => r.afterBytes);
  return {
    rows,
    total: {
      beforeBytes,
      afterBytes,
      tokensBefore: sum((r) => r.tokensBefore),
      tokensAfter: sum((r) => r.tokensAfter),
      reduction: reductionPercent(beforeBytes, afterBytes),
      runs: comparable.length,
    },
  };
}

export const bytesOrNull = (n: number | null): string | null => (n === null ? null : formatBytes(n));
export const tokensOrNull = (n: number | null): string | null => (n === null ? null : `~${n.toLocaleString("pt-BR")}`);
