import type { AgentAccount } from "./types";

/** A conta do sistema não tem linha no banco e não deve virar um ID de perfil no IPC. */
export function accountLoginAccountId(accountId: string): string | undefined {
  return accountId.startsWith("system:") ? undefined : accountId;
}

export function accountLoginCommand(account: AgentAccount): string {
  return account.agentId === "claude-code" ? "claude auth login --claudeai" : account.loginCommand;
}
