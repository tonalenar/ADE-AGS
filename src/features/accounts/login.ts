import type { AgentAccount } from "./types";

/** The main account has no database row and must use the CLI's default profile. */
export function accountLoginEnv(
  accountId: string,
  envFor: (id: string) => Promise<Record<string, string>>,
): Promise<Record<string, string>> {
  return accountId.startsWith("system:") ? Promise.resolve({}) : envFor(accountId);
}

export function accountLoginCommand(account: AgentAccount): string {
  return account.agentId === "claude-code" ? "claude auth login --claudeai" : account.loginCommand;
}
