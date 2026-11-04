import type { RosterAccount, RosterAgent } from "@/features/runs/types";

/** O estado de uma conta como o seletor mostra: sem login, limite esgotado (a renovação ainda não passou) ou pronta. */
export type AccountState = "ready" | "exhausted" | "needsLogin";

export function accountState(account: RosterAccount, now: number): AccountState {
  if (!account.loggedIn) return "needsLogin";
  const q = account.quota;
  if (q?.rejected && (q.rejectedUntil === null || q.rejectedUntil > now)) return "exhausted";
  return "ready";
}

export interface ChoosableAccount {
  /** O valor do seletor: `""` = a conta principal do agente. */
  value: string;
  name: string;
  state: AccountState;
}

/** As contas do agente para escolher, nome ou e-mail (o rótulo) e estado. A principal vem primeiro. */
export function choosableAccounts(agent: RosterAgent | undefined, now: number): ChoosableAccount[] {
  return (agent?.accounts ?? []).map((a) => ({ value: a.accountId ?? "", name: a.label ?? a.name, state: accountState(a, now) }));
}

/** Só vale mostrar o seletor com mais de uma conta para escolher. */
export const hasChoice = (agent: RosterAgent | undefined): boolean => (agent?.accounts.length ?? 0) > 1;
