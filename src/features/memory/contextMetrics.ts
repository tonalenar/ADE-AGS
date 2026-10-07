/**
 * Métrica do contexto de memória de um Run (Etapa 24): quanto era despejado antes e quanto vai
 * agora (índice + top-K). A forma vem do contrato com o Backend (`memory_context_metrics`); aqui só
 * ficam o tipo e o formato de exibição, puros. Os nomes podem mudar quando o Backend entregar.
 */
export interface MemoryContextMetrics {
  runId: string;
  beforeBytes: number;
  afterBytes: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Hash do commit do repositório de memória selado no Run. */
  commit: string | null;
  entriesUsed: number;
  tokenMethod: "project-estimate-chars-div-4";
  legacyContext?: boolean;
}

export interface MemoryMissionContextMetrics {
  runs: MemoryContextMetrics[];
}

/** Redução percentual (0-100, inteira); 0 se não havia nada antes ou se cresceu. */
export function reductionPercent(before: number, after: number): number {
  if (!(before > 0) || after >= before) return 0;
  return Math.round(((before - after) / before) * 100);
}

/** "3,0 KiB" / "812 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
