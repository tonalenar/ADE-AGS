import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import i18n from "i18next";
import { create } from "zustand";

import { formatPoolError, isPoolValue, poolNameOf } from "@/features/accounts/poolRef";

export type PoolStrategy = "least_used" | "round_robin" | "sticky";

export const STRATEGIES: PoolStrategy[] = ["least_used", "round_robin", "sticky"];

/** Un pool de cuentas de una misma TUI (ver `accounts/pools.rs`). `members`: ids de cuenta, `null` = la del sistema. */
export interface Pool {
  id: string;
  name: string;
  agentId: string;
  members: (string | null)[];
  strategy: PoolStrategy;
  /** Campo legado de failover por pool; substituído por `paused` + modo global. */
  failover: boolean;
  /** Pausa as trocas neste pool. Default: false. */
  paused?: boolean;
}

/** Prévia somente leitura de qual conta o pool escolheria agora (`routing::pick_in_pool`). */
export interface PoolPickPreview {
  poolId: string;
  /** `null` = conta principal/do sistema; `string` = id da conta extra; `undefined` quando `available === false`. */
  accountId: string | null;
  available: boolean;
  swapsToday: number;
}

// O valor serializado e helpers puros de pool vivem em `poolRef.ts` (sem Tauri); reexportados aqui.
export {
  POOL_PREFIX,
  affectedPoolsOnAccountDelete,
  formatPoolError,
  isPoolEmpty,
  isPoolValue,
  poolNameOf,
  poolValue,
} from "@/features/accounts/poolRef";

interface PoolsState {
  pools: Pool[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const usePoolsStore = create<PoolsState>((set) => ({
  pools: [],
  loaded: false,
  load: async () => {
    const pools = await invoke<Pool[]>("pool_list_all");
    set({ pools, loaded: true });
  },
}));

/** Los pools, al día: se piden al montar y cuando algo los cambia (la CLI, otra ventana). */
export function usePools(agentId?: string | null): Pool[] {
  const pools = usePoolsStore((s) => s.pools);
  const load = usePoolsStore((s) => s.load);
  useEffect(() => {
    load().catch(() => undefined);
    const off = listen("cc-pools-changed", () => load().catch(() => undefined));
    return () => {
      off.then((fn) => fn());
    };
  }, [load]);
  return agentId ? pools.filter((p) => p.agentId === agentId) : pools;
}

export const poolSaveNew = (
  name: string,
  agentId: string,
  members: (string | null)[],
  strategy: PoolStrategy,
  failover = true,
) => invoke<Pool>("pool_save_new", { name, agentId, members, strategy, failover });

/** Atualiza nome, membros, ordem e estratégia de um pool existente preservando o `id`. */
export const poolUpdate = (
  id: string,
  name: string,
  members: (string | null)[],
  strategy: PoolStrategy,
) => invoke<Pool>("pool_update", { id, name, members, strategy });

export const poolRemove = (id: string) => invoke<void>("pool_remove", { id });

/** Liga/desliga failover num pool já existente, sem recriá-lo. */
export const poolSetFailover = (id: string, enabled: boolean) => invoke<Pool>("pool_set_failover", { id, enabled });

/** Pausa ou retoma as trocas neste pool. */
export const poolSetPaused = (id: string, paused: boolean) => invoke<Pool>("pool_set_paused", { id, paused });

/** Prévia de qual conta cada pool escolheria agora (reusa `routing::pick_in_pool` sem avançar cursor). */
export const poolPreviewPicks = () => invoke<PoolPickPreview[]>("pool_preview_picks");

/** La cuenta que elige ese pool ahora (`null` = la del sistema). */
export const poolPick = (agentId: string, pool: string) => invoke<string | null>("pool_pick", { agentId, pool });

/** Lo que se pasa a `addTab` como cuenta: si es un pool, el pool decide ahora; si no, el id tal cual. */
export async function resolveAccountChoice(agentId: string, value: string | undefined): Promise<string | undefined> {
  if (!isPoolValue(value)) return value;
  try {
    return (await poolPick(agentId, poolNameOf(value))) ?? undefined;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const formatted = formatPoolError(raw, (key, vars) => i18n.t(key, vars));
    if (formatted !== raw) throw new Error(formatted);
    throw e;
  }
}
