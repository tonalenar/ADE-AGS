import type { LiveUsage } from "@/features/accounts/usage";
import type { AgyEntry, AntigravityEntry, CodexEntry } from "@/features/canvas/usageStore";

import type { RailItem } from "./pickerRail";
import {
  WARN_ABOVE,
  accountKeyOf,
  headlineOf,
  limitLevel,
  readAgy,
  readAntigravity,
  readClaude,
  readCodex,
  type AccountEntry,
  type AccountReading,
  type LimitLevel,
} from "./summary/limitsModel";

/** A cor do preenchimento por nível, a mesma do cartão "Limites de uso". */
export const LIMIT_FILL: Record<LimitLevel, string> = {
  unknown: "bg-gray-300 dark:bg-white/25",
  ok: "bg-accent-500",
  warn: "bg-amber-500",
  full: "bg-rose-500",
};

/** O que o seletor lê do `useUsageStore` (as leituras que a ADE já faz; nada novo é pedido aqui). */
export interface UsageSnapshot {
  claude: Record<string, LiveUsage>;
  codex: Record<string, CodexEntry>;
  antigravity: Record<string, AntigravityEntry>;
  agy: AgyEntry;
}

/**
 * O percentual de limite mais gasto de uma conta do trilho (0–100), com as mesmas leituras e a
 * mesma regra do cartão "Limites de uso" do Resumo. `null` = não medido (sem leitura, sem login,
 * falha, janela já renovada ou agente sem fonte de cota): nesse caso não há barra, nunca um número
 * inventado. Pura.
 */
export function limitPercentFor(item: RailItem, usage: UsageSnapshot, now: number): number | null {
  const key = accountKeyOf(item.agentId, item.accountId);
  let reading: AccountReading;
  switch (item.agentId) {
    case "claude-code":
      reading = readClaude(usage.claude[key] ?? null, item.loggedIn, now);
      break;
    case "codex":
      reading = readCodex(usage.codex[key], item.loggedIn, now);
      break;
    case "antigravity":
      // Sem perfil é o login local do `agy`, como no cartão do Resumo.
      reading = item.accountId === null
        ? readAgy(usage.agy, item.loggedIn, now)
        : readAntigravity(usage.antigravity[key], item.loggedIn, now);
      break;
    default:
      return null;
  }
  return headlineOf(reading);
}

/** A barra só aparece onde ajuda a escolher entre contas (agente com mais de um ícone) e há um número. */
export function shouldShowRailLimit(item: RailItem, rail: readonly RailItem[], percent: number | null): boolean {
  if (percent === null) return false;
  return rail.filter((other) => other.agentId === item.agentId).length > 1;
}

export interface OtherAccountSummaryItem {
  entry: AccountEntry;
  reading: AccountReading;
  percent: number | null;
  level: LimitLevel;
}

export interface OtherAccountsSummary {
  count: number;
  /** Quantas contas em "Outras contas" passaram de 80% (ou estão esgotadas). */
  highUsageCount: number;
  /** Maior nível entre as contas acima de 80% (`full` se alguma chegou a 100%, senão `warn`). */
  warningLevel: "warn" | "full" | null;
  items: OtherAccountSummaryItem[];
}

/** Resume o grupo recolhível "Outras contas" do cartão Limites de uso. Pura. */
export function summarizeOtherAccounts(
  entries: readonly AccountEntry[],
  readEntry: (entry: AccountEntry) => AccountReading,
): OtherAccountsSummary {
  let highUsageCount = 0;
  let hasFull = false;
  const items: OtherAccountSummaryItem[] = entries.map((entry) => {
    const reading = readEntry(entry);
    const percent = headlineOf(reading);
    const level = limitLevel(percent);
    if (percent !== null && percent > WARN_ABOVE) {
      highUsageCount += 1;
      if (level === "full") hasFull = true;
    }
    return { entry, reading, percent, level };
  });
  return {
    count: items.length,
    highUsageCount,
    warningLevel: highUsageCount > 0 ? (hasFull ? "full" : "warn") : null,
    items,
  };
}
