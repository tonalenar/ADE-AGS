import type { AgentAccount } from "@/features/accounts/types";

/** Os agentes cujo aviso de várias contas a ADE mostra (como o `MultipleAccountsNote` do T3 Code). */
const WARNED_AGENTS = new Set(["claude-code", "codex"]);

/**
 * Mostra o aviso ao adicionar a 2ª conta de Claude ou Codex: quando já há uma conta do mesmo agente
 * com login (a principal ou uma criada). Na primeira conta não há o que avisar. Pura.
 */
export function shouldWarnMultipleAccounts(
  agentId: string,
  accounts: readonly AgentAccount[],
  systemAccounts: readonly AgentAccount[],
): boolean {
  if (!WARNED_AGENTS.has(agentId)) return false;
  return [...systemAccounts, ...accounts].some((account) => account.agentId === agentId && account.loggedIn);
}
