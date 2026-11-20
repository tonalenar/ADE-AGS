import type { LiveUsage } from "@/features/accounts/usage";
import type { AgyEntry, AntigravityEntry, CodexEntry } from "@/features/canvas/usageStore";

import type { RailItem } from "./pickerRail";
import { accountKeyOf, headlineOf, readAgy, readAntigravity, readClaude, readCodex, type AccountReading, type LimitLevel } from "./summary/limitsModel";

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
