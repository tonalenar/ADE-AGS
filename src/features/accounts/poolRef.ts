/** O valor serializado de um pool, que vai no lugar do id de uma conta: `pool:<nome>`. Sem Tauri, para qualquer um importar. */
export const POOL_PREFIX = "pool:";

export const poolValue = (name: string) => `${POOL_PREFIX}${name}`;
export const isPoolValue = (value: string | undefined): value is string => !!value && value.toLowerCase().startsWith(POOL_PREFIX);
export const poolNameOf = (value: string) => value.slice(POOL_PREFIX.length).trim();

export type LiveAccountRef = string | { id: string; agentId?: string };

/**
 * Um pool sem nenhum membro vivo: lista vazia ou só referências a contas que não existem mais.
 * - `null` representa a conta principal do sistema e sempre conta como membro vivo.
 * - Quando `liveAccounts` é omitido (ex.: contas ainda não carregadas), verifica apenas `members.length === 0`.
 */
export function isPoolEmpty(
  pool: { agentId?: string; members: readonly (string | null)[] },
  liveAccounts?: readonly LiveAccountRef[] | ReadonlySet<string>,
): boolean {
  if (pool.members.length === 0) return true;
  if (!liveAccounts) return false;
  if (!Array.isArray(liveAccounts)) {
    const ids = liveAccounts as ReadonlySet<string>;
    return !pool.members.some((m) => m === null || ids.has(m));
  }
  const hasLive = (id: string) =>
    liveAccounts.some((acc) => {
      if (typeof acc === "string") return acc === id;
      if (acc.id !== id) return false;
      return !pool.agentId || !acc.agentId || acc.agentId === pool.agentId;
    });
  return !pool.members.some((m) => m === null || hasLive(m));
}

/**
 * Classifica os pools afetados ao apagar uma conta:
 * - `kept`: pools que perdem a conta mas continuam com outras vivas;
 * - `emptied`: pools que ficarão sem nenhum membro vivo (vazios) após a remoção.
 */
export function affectedPoolsOnAccountDelete(
  pools: readonly { name: string; agentId?: string; members: readonly (string | null)[] }[],
  accountId: string,
  liveAccounts?: readonly LiveAccountRef[] | ReadonlySet<string>,
): { kept: string[]; emptied: string[] } {
  const kept: string[] = [];
  const emptied: string[] = [];
  for (const pool of pools) {
    if (!pool.members.includes(accountId)) continue;
    const remaining = pool.members.filter((m) => m !== accountId);
    if (isPoolEmpty({ agentId: pool.agentId, members: remaining }, liveAccounts)) emptied.push(pool.name);
    else kept.push(pool.name);
  }
  return { kept, emptied };
}

type TranslateFn = (key: string, vars?: Record<string, unknown>) => string;

interface PoolErrorPayload {
  code?: unknown;
  pool?: unknown;
}

function parsePoolErrorPayload(text: string): PoolErrorPayload | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PoolErrorPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Traduz erros estruturados de pool vindos do backend (ex.: `{"code":"poolEmpty","pool":"Trabalho"}`),
 * aceitando também o formato envelopado (`Pool 'X': {"code":"poolEmpty",...}`).
 * Qualquer outro erro volta inalterado.
 */
export function formatPoolError(raw: unknown, t: TranslateFn): string {
  const text = raw instanceof Error ? raw.message : String(raw);
  const payload = parsePoolErrorPayload(text);
  if (payload?.code === "poolEmpty" && typeof payload.pool === "string") {
    return t("accounts.pools.error.empty", { name: payload.pool });
  }
  return text;
}
