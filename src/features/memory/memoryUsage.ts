/**
 * O uso da memória pelos agentes (quem leu o quê) e a limpeza do que sobrou. A leitura é `memory_usage_report`
 * (o backend registra cada busca/abertura/índice); a limpeza é `memory_cleanup_*`. Lógica pura aqui.
 */
import { invoke } from "@tauri-apps/api/core";

export interface UsageMission {
  missionId: string;
  title: string;
  injected: number;
  searches: number;
  opens: number;
  hitsTotal: number;
}

export interface UsageReport {
  total: number;
  injected: number;
  searches: number;
  searchesWithHits: number;
  opens: number;
  indexReads: number;
  distinctAgents: number;
  topRead: { key: string; count: number }[];
  neverRead: number;
  activeEntries: number;
  missions: UsageMission[];
}

export interface CleanupCandidate {
  entryId: string;
  scope: "workspace" | "mission";
  missionId: string | null;
  key: string;
  kind: string;
  bodyPreview: string;
  reasons: string[];
}

export interface CleanupResult {
  deleted: number;
  failed: { entryId: string; error: string }[];
}

export const fetchUsage = (workspaceId: string) =>
  invoke<UsageReport>("memory_usage_report", { workspaceId, sinceTs: null });

export const fetchCandidates = (workspaceId: string) =>
  invoke<CleanupCandidate[]>("memory_cleanup_candidates", { workspaceId });

export const applyCleanup = (workspaceId: string, entryIds: string[]) =>
  invoke<CleanupResult>("memory_cleanup_apply", { workspaceId, entryIds });

/** Quantas leituras DE VERDADE houve: o que o agente pediu (busca, abertura, índice). A injeção não conta: é o app que entrega. Pura. */
export function agentReads(report: UsageReport): number {
  return report.searches + report.opens + report.indexReads;
}

/**
 * O que dá para dizer hoje: "unknown" sem nenhum registro, "unused" quando só se injetou e nenhum agente pediu
 * nada, "weak" quando menos de 1 de cada 4 buscas achou algo ou menos de 10% do que existe foi lido, e "active"
 * no resto. Pura.
 */
export type UsageVerdict = "unknown" | "unused" | "weak" | "active";

export function usageVerdict(report: UsageReport | null): UsageVerdict {
  if (!report || report.total === 0) return "unknown";
  if (agentReads(report) === 0) return "unused";
  const hitRate = report.searches > 0 ? report.searchesWithHits / report.searches : 1;
  const coverage = report.activeEntries > 0 ? 1 - report.neverRead / report.activeEntries : 1;
  return hitRate < 0.25 || coverage < 0.1 ? "weak" : "active";
}

/** Percentual inteiro (0 a 100) ou nulo quando não há base. Pura. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** O que se marca de uma vez na limpeza: o que tem 2+ motivos, ou é duplicada, ou chave de teste. Pura. */
export function suggestedIds(list: CleanupCandidate[]): string[] {
  return list
    .filter((c) => c.reasons.length >= 2 || c.reasons.some((r) => r.startsWith("duplicada") || r.startsWith("chave de teste")))
    .map((c) => c.entryId);
}
