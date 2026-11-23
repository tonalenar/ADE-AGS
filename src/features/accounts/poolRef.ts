/** O valor serializado de um pool, que vai no lugar do id de uma conta: `pool:<nome>`. Sem Tauri, para qualquer um importar. */
export const POOL_PREFIX = "pool:";

export const poolValue = (name: string) => `${POOL_PREFIX}${name}`;
export const isPoolValue = (value: string | undefined): value is string => !!value && value.toLowerCase().startsWith(POOL_PREFIX);
export const poolNameOf = (value: string) => value.slice(POOL_PREFIX.length).trim();

/** Um pool sem nenhuma conta restante (ex.: após todas as contas dele terem sido removidas). */
export const isPoolEmpty = (pool: { members: readonly (string | null)[] }): boolean => pool.members.length === 0;

/**
 * Classifica os pools afetados ao apagar uma conta:
 * - `kept`: pools que perdem a conta mas continuam com outras;
 * - `emptied`: pools que ficarão com 0 membros (vazios) após a remoção.
 */
export function affectedPoolsOnAccountDelete(
  pools: readonly { name: string; members: readonly (string | null)[] }[],
  accountId: string,
): { kept: string[]; emptied: string[] } {
  const kept: string[] = [];
  const emptied: string[] = [];
  for (const pool of pools) {
    if (!pool.members.includes(accountId)) continue;
    const remaining = pool.members.filter((m) => m !== accountId);
    if (remaining.length === 0) emptied.push(pool.name);
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
