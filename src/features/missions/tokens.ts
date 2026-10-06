import { invoke } from "@tauri-apps/api/core";

/** Costo ESTIMADO con precio de lista (los tokens son medidos, el precio es de tabla) y ahorro del caché. */
export interface CostEstimate {
  costUsd: number;
  savedUsd: number;
  /** Modelos que la tabla de precios no conoce: sus tokens no entran en el costo. */
  unpricedModels: string[];
}

export type TabKind = "member" | "recruit" | "custom" | "loose";
export type TabSource = "session" | "isolated_cwd" | "ledger";

/** Gasto de UMA aba/terminal. Os totais são a soma das abas (a aba detalha, nunca soma de novo). */
export interface TabTokens {
  tabId: string;
  agentId: string;
  label: string;
  /** Papel da aba; o backend pode omitir. */
  kind?: TabKind | null;
  cwd: string | null;
  sessionId: string | null;
  /** De onde veio a medição; `null` quando não medido. */
  source: TabSource | null;
  measured: boolean;
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  costUsd: number | null;
  estimate?: CostEstimate | null;
}

export interface AgentTokens {
  agentId: string;
  measured: boolean;
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  costUsd: number | null;
  estimate?: CostEstimate | null;
}

export interface MissionTokens {
  agents: AgentTokens[];
  /** Detalhe por aba/terminal; ausente em backends antigos. */
  tabs?: TabTokens[];
}

export const getTokens = (missionId: string) => invoke<MissionTokens>("mission_tokens", { missionId });

/** "12,3 mil", "4,5 mi", "930": compacta número grande. Pura, sem i18n (mesmo padrão de formatDuration). */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const tiers: Array<[number, string]> = [
    [1_000_000_000, "bi"],
    [1_000_000, "mi"],
    [1_000, "mil"],
  ];
  for (const [factor, suffix] of tiers) {
    if (abs < factor) continue;
    const value = Math.round((abs / factor) * 10) / 10;
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
    return `${sign}${text} ${suffix}`;
  }
  return `${sign}${Math.round(abs)}`;
}

/** % do input que veio de cache (cacheRead / (input + cacheRead + cacheWrite)), só quando measured. Pura. */
export function cacheReadShare(a: AgentTokens): number | null {
  if (!a.measured || a.input === null || a.cacheRead === null || a.cacheWrite === null) return null;
  const total = a.input + a.cacheRead + a.cacheWrite;
  if (total <= 0) return null;
  return Math.round((a.cacheRead / total) * 100);
}

/** La estimación de toda la misión: suma la de cada agente con tokens medidos; `null` si ninguno. Pura. */
export function estimateOf(data: MissionTokens | null | undefined): CostEstimate | null {
  let total: CostEstimate | null = null;
  for (const a of data?.agents ?? []) {
    if (!a.estimate) continue;
    total ??= { costUsd: 0, savedUsd: 0, unpricedModels: [] };
    total.costUsd += a.estimate.costUsd;
    total.savedUsd += a.estimate.savedUsd;
    for (const m of a.estimate.unpricedModels) if (!total.unpricedModels.includes(m)) total.unpricedModels.push(m);
  }
  return total;
}

/** "US$ 1,23": dos decimales, o "—" sin dato. Pura. */
export function formatUsd(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `US$ ${value.toFixed(2).replace(".", ",")}`;
}

export interface TokenRow extends AgentTokens {
  cacheReadSharePct: number | null;
  isTotal: boolean;
}

function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? present.reduce((sum, v) => sum + v, 0) : null;
}

/** Linhas prontas pra tabela: uma por agente + 1 total da missão. Pura. */
export function tokenRows(data: MissionTokens): TokenRow[] {
  const rows: TokenRow[] = data.agents.map((a) => ({ ...a, cacheReadSharePct: cacheReadShare(a), isTotal: false }));
  if (data.agents.length === 0) return rows;

  const total: AgentTokens = {
    agentId: "total",
    measured: data.agents.some((a) => a.measured),
    input: sumOrNull(data.agents.map((a) => a.input)),
    output: sumOrNull(data.agents.map((a) => a.output)),
    cacheWrite: sumOrNull(data.agents.map((a) => a.cacheWrite)),
    cacheRead: sumOrNull(data.agents.map((a) => a.cacheRead)),
    costUsd: sumOrNull(data.agents.map((a) => a.costUsd)),
  };
  rows.push({ ...total, cacheReadSharePct: cacheReadShare(total), isTotal: true });
  return rows;
}

/** Custo de uma aba pra exibir: estimativa de tabela se houver, senão o custo medido; `null` = "não medido". Pura. */
export function tabCostUsd(tab: Pick<TabTokens, "measured" | "costUsd" | "estimate">): number | null {
  if (!tab.measured) return null;
  return tab.estimate?.costUsd ?? tab.costUsd ?? null;
}

/** Total de tokens (input+output+cache) de uma aba; `null` sem medição. Pura. */
export function tabTotalTokens(tab: Pick<TabTokens, "measured" | "input" | "output" | "cacheWrite" | "cacheRead">): number | null {
  if (!tab.measured) return null;
  return sumOrNull([tab.input, tab.output, tab.cacheWrite, tab.cacheRead]);
}

/** Abas de um agente em ordem estável: medidas primeiro (mais caras antes), "não medido" no fim. Pura. */
export function tabsOfAgent(data: MissionTokens | null | undefined, agentId: string): TabTokens[] {
  return (data?.tabs ?? [])
    .filter((tab) => tab.agentId === agentId)
    .sort((a, b) => {
      if (a.measured !== b.measured) return a.measured ? -1 : 1;
      return (tabCostUsd(b) ?? 0) - (tabCostUsd(a) ?? 0) || a.label.localeCompare(b.label);
    });
}

/** Soma das abas medidas (tokens e custo); `null` se nenhuma foi medida. Serve pra conferir contra o total. Pura. */
export function tabsSum(tabs: TabTokens[]): { tokens: number | null; costUsd: number | null } {
  return { tokens: sumOrNull(tabs.map(tabTotalTokens)), costUsd: sumOrNull(tabs.map(tabCostUsd)) };
}
