import { getSetting, setSetting } from "@/shared/ipc/settings";
import type { AgentAccount } from "./types";

const PRIMARY_PREFIX = "accounts.primary.";

export const primaryAccountKey = (agentId: string) => `${PRIMARY_PREFIX}${agentId}`;

/** Lê qual conta a pessoa marcou como principal para um agente (`null` = conta do sistema). */
export async function loadPrimaryAccount(agentId: string): Promise<string | null> {
  const raw = await getSetting(primaryAccountKey(agentId)).catch(() => null);
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : null;
}

/** Grava qual conta é a principal de um agente (aditivo em `settings`, sem tocar perfis). */
export async function savePrimaryAccount(agentId: string, accountId: string): Promise<void> {
  await setSetting(primaryAccountKey(agentId), accountId);
}

/** Decide se uma conta é a principal ativa do agente (padrão: `system:<agentId>`). Pura. */
export function isPrimaryAccount(account: Pick<AgentAccount, "id" | "agentId">, primaryId: string | null | undefined): boolean {
  if (primaryId) return account.id === primaryId;
  return account.id.startsWith("system:");
}

/** Ordena as contas do agente deixando a principal sempre primeiro. Pura. */
export function sortWithPrimaryFirst<T extends Pick<AgentAccount, "id" | "agentId" | "name">>(
  accounts: readonly T[],
  primaryId: string | null | undefined,
): T[] {
  const hasExplicit = primaryId ? accounts.some((a) => a.id === primaryId) : false;
  const effective = hasExplicit ? primaryId : null;
  return [...accounts].sort((a, b) => {
    const aMain = isPrimaryAccount(a, effective) ? 1 : 0;
    const bMain = isPrimaryAccount(b, effective) ? 1 : 0;
    if (aMain !== bMain) return bMain - aMain;
    return a.name.localeCompare(b.name);
  });
}
