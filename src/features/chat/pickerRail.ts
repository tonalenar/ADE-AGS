import { accountDisplayLabel, shouldShowAccountBadge } from "@/features/accounts/accountIdentity";
import type { AgentAccount } from "@/features/accounts/types";
import type { Roster } from "@/features/runs/types";

/**
 * O trilho do seletor de modelo: um ícone por agente e, quando o agente tem mais de uma conta,
 * um por conta (como no T3 Code). A chave de um item junta o agente e a conta (`agente::conta`);
 * sem conta é só o id do agente. `fav` é a aba de favoritos.
 */
export const RAIL_FAVORITES = "fav";
const SEP = "::";

export const railKeyOf = (agentId: string, account: string | null): string =>
  account ? `${agentId}${SEP}${account}` : agentId;

export function parseRailKey(key: string): { tab: string; account: string | null } {
  if (key === RAIL_FAVORITES) return { tab: RAIL_FAVORITES, account: null };
  const at = key.indexOf(SEP);
  if (at < 0) return { tab: key, account: null };
  return { tab: key.slice(0, at), account: key.slice(at + SEP.length) || null };
}

export interface RailItem {
  key: string;
  agentId: string;
  /** `null` = a conta principal (ou a única). */
  accountId: string | null;
  /** O nome acessível do ícone: "Claude Code" ou "Claude Code · Trabalho". */
  name: string;
  /** O texto de que saem as iniciais do selo. */
  badgeLabel: string;
  /** Nome de um token do tema (ver `accountIdentity.ts`). */
  accentColor: string | null;
  showBadge: boolean;
  loggedIn: boolean;
}

/**
 * Monta os itens do trilho. `identities` são as contas da loja (`useAccountsStore`: as criadas
 * mais as principais `system:<agente>`), de onde vêm nome de exibição e cor; o roster dá a
 * lista de contas que existem agora e se estão com login.
 */
export function buildRail(
  agents: ReadonlyArray<{ id: string; label: string }>,
  roster: Roster | null,
  identities: readonly AgentAccount[],
  principalLabel: string,
  /** `false` numa conversa aberta: a conta não muda, então o trilho volta a um ícone por agente, sem selo. */
  perAccount = true,
): RailItem[] {
  return agents.flatMap((agent) => {
    const accounts = perAccount ? roster?.agents.find((a) => a.agentId === agent.id)?.accounts ?? [] : [];
    const sources = accounts.length > 0
      ? accounts.map((a) => ({ accountId: a.accountId, name: a.name, email: a.label, loggedIn: a.loggedIn }))
      : [{ accountId: null, name: agent.label, email: null, loggedIn: true }];
    const entries = sources.map((source) => {
      const id = source.accountId ?? `system:${agent.id}`;
      const identity = identities.find((i) => i.id === id);
      return {
        source,
        who: {
          id, agentId: agent.id, name: source.name,
          displayName: identity?.displayName ?? null, accentColor: identity?.accentColor ?? null,
        },
      };
    });
    const everyone = entries.map((e) => e.who);
    const multiple = entries.length > 1;
    return entries.map(({ source, who }): RailItem => {
      const badgeLabel = accountDisplayLabel(who, principalLabel);
      const showBadge = perAccount && shouldShowAccountBadge(who, everyone);
      const shown = who.displayName?.trim() || (source.accountId ? source.email ?? badgeLabel : badgeLabel);
      return {
        key: railKeyOf(agent.id, source.accountId),
        agentId: agent.id,
        accountId: source.accountId,
        name: multiple || showBadge ? `${agent.label} · ${shown}` : agent.label,
        badgeLabel,
        accentColor: who.accentColor,
        showBadge,
        loggedIn: source.loggedIn,
      };
    });
  });
}
