import { invoke } from "@tauri-apps/api/core";

export interface AgentTokens {
  agentId: string;
  measured: boolean;
  input: number | null;
  output: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  costUsd: number | null;
}

export interface MissionTokens {
  agents: AgentTokens[];
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
