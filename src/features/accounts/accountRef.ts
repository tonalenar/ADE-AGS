import { isPoolValue, poolNameOf, poolValue } from "@/features/accounts/poolRef";

/**
 * A conta escolhida para um agente, como valor único e tipado. Antes o seletor passava uma
 * string que misturava o id de uma conta e `pool:<nome>`, e cada ponto testava o prefixo.
 *
 * - `account` com `accountId: null` é a conta principal (a do sistema);
 * - `pool` é um pool de contas do agente, que só vira uma conta de verdade ao abrir a aba.
 *
 * Na fronteira (preferências salvas, `addTab`, backend) o valor continua sendo a string de
 * sempre: `accountRefToWire` / `accountRefFromWire` fazem a ida e a volta, e a serialização
 * não mudou.
 */
export type AccountRef =
  | { kind: "account"; agentId: string; accountId: string | null }
  | { kind: "pool"; agentId: string; pool: string };

export const principalRef = (agentId: string): AccountRef => ({ kind: "account", agentId, accountId: null });

/** Lê o valor serializado (id, `pool:<nome>`, vazio ou ausente). */
export function accountRefFromWire(agentId: string, wire: string | null | undefined): AccountRef {
  const value = wire?.trim();
  if (!value) return principalRef(agentId);
  if (isPoolValue(value)) {
    const pool = poolNameOf(value);
    return pool ? { kind: "pool", agentId, pool } : principalRef(agentId);
  }
  return { kind: "account", agentId, accountId: value };
}

/** O valor serializado: o id da conta, `pool:<nome>` ou `null` (a conta principal). */
export function accountRefToWire(ref: AccountRef | null | undefined): string | null {
  if (!ref) return null;
  return ref.kind === "pool" ? poolValue(ref.pool) : ref.accountId;
}

/** O id de uma conta real; `null` para a principal, para um pool e para nada. */
export const selectedAccountId = (ref: AccountRef | null | undefined): string | null =>
  ref?.kind === "account" ? ref.accountId : null;

/** Mesma escolha? Ausente vale como a conta principal do `agentId` dado. */
export function sameAccountRef(a: AccountRef | null | undefined, b: AccountRef | null | undefined, agentId?: string): boolean {
  const left = a ?? (agentId ? principalRef(agentId) : null);
  const right = b ?? (agentId ? principalRef(agentId) : null);
  if (!left || !right) return left === right;
  if (left.agentId !== right.agentId || left.kind !== right.kind) return false;
  return left.kind === "pool"
    ? left.pool === (right as typeof left).pool
    : left.accountId === (right as typeof left & { kind: "account" }).accountId;
}
