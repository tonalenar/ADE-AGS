/** O valor serializado de um pool, que vai no lugar do id de uma conta: `pool:<nome>`. Sem Tauri, para qualquer um importar. */
export const POOL_PREFIX = "pool:";

export const poolValue = (name: string) => `${POOL_PREFIX}${name}`;
export const isPoolValue = (value: string | undefined): value is string => !!value && value.toLowerCase().startsWith(POOL_PREFIX);
export const poolNameOf = (value: string) => value.slice(POOL_PREFIX.length).trim();
