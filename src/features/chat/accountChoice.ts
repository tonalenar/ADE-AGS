import type { AgentAccount } from "@/features/accounts/types";
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

export interface AccountChoiceOptions {
  /** A conta atualmente selecionada na conversa (`null` = principal). */
  currentAccountId?: string | null;
  /** Rótulo fallback da conta principal quando ela não tem nome de exibição nem e-mail. */
  principalLabel?: string;
  /** Identidades da loja (`systemAccounts` + `accounts`) para respeitar `displayName`. */
  identities?: readonly AgentAccount[];
}

function normalizedLabel(label: string | null | undefined): string | null {
  const clean = label?.trim().toLowerCase();
  return clean ? clean : null;
}

/**
 * Remove entradas duplicadas da mesma conta no roster: por id ou quando uma conta extra
 * está logada com o mesmo e-mail (`label`) de outra conta já listada (ex.: principal).
 * Se uma duplicata corresponde a `currentAccountId`, mantém a entrada ativa no lugar da inativa.
 */
export function dedupeRosterAccounts(
  accounts: readonly RosterAccount[],
  currentAccountId?: string | null,
): RosterAccount[] {
  const result: RosterAccount[] = [];
  const seenIds = new Set<string>();
  const labelIndex = new Map<string, number>();

  for (const account of accounts) {
    const idKey = account.accountId ?? "";
    if (seenIds.has(idKey)) continue;
    const emailKey = normalizedLabel(account.label);
    if (emailKey !== null) {
      const existingAt = labelIndex.get(emailKey);
      if (existingAt !== undefined) {
        const isCurrent = currentAccountId !== undefined && account.accountId === currentAccountId;
        const existingIsCurrent = currentAccountId !== undefined && result[existingAt]!.accountId === currentAccountId;
        if (isCurrent && !existingIsCurrent) {
          seenIds.delete(result[existingAt]!.accountId ?? "");
          seenIds.add(idKey);
          result[existingAt] = account;
        }
        continue;
      }
      labelIndex.set(emailKey, result.length);
    }
    seenIds.add(idKey);
    result.push(account);
  }

  return result;
}

/** As contas do agente para escolher, nome ou e-mail (o rótulo) e estado. A principal vem primeiro. */
export function choosableAccounts(
  agent: RosterAgent | undefined,
  now: number,
  options?: AccountChoiceOptions,
): ChoosableAccount[] {
  if (!agent) return [];
  const unique = dedupeRosterAccounts(agent.accounts, options?.currentAccountId);
  return unique.map((a) => {
    const id = a.accountId ?? `system:${agent.agentId}`;
    const custom = options?.identities?.find((i) => i.id === id)?.displayName?.trim();
    const fallback = a.accountId === null && options?.principalLabel ? options.principalLabel : a.name;
    return {
      value: a.accountId ?? "",
      name: custom || a.label?.trim() || fallback,
      state: accountState(a, now),
    };
  });
}

/** Só vale mostrar o seletor com mais de uma conta distinta para escolher. */
export const hasChoice = (
  agent: RosterAgent | undefined,
  _now?: number,
  options?: AccountChoiceOptions,
): boolean => dedupeRosterAccounts(agent?.accounts ?? [], options?.currentAccountId).length > 1;
