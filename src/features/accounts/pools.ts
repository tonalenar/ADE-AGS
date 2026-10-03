import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type PoolStrategy = "least_used" | "round_robin" | "sticky";

export const STRATEGIES: PoolStrategy[] = ["least_used", "round_robin", "sticky"];

/** Un pool de cuentas de una misma TUI (ver `accounts/pools.rs`). `members`: ids de cuenta, `null` = la del sistema. */
export interface Pool {
  id: string;
  name: string;
  agentId: string;
  members: (string | null)[];
  strategy: PoolStrategy;
}

/** Donde iría una cuenta, un pool se pide así. */
export const POOL_PREFIX = "pool:";

export const poolValue = (name: string) => `${POOL_PREFIX}${name}`;
export const isPoolValue = (value: string | undefined): value is string => !!value && value.toLowerCase().startsWith(POOL_PREFIX);
export const poolNameOf = (value: string) => value.slice(POOL_PREFIX.length).trim();

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

export const poolSaveNew = (name: string, agentId: string, members: (string | null)[], strategy: PoolStrategy) =>
  invoke<Pool>("pool_save_new", { name, agentId, members, strategy });

export const poolRemove = (id: string) => invoke<void>("pool_remove", { id });

/** La cuenta que elige ese pool ahora (`null` = la del sistema). */
export const poolPick = (agentId: string, pool: string) => invoke<string | null>("pool_pick", { agentId, pool });

/** Lo que se pasa a `addTab` como cuenta: si es un pool, el pool decide ahora; si no, el id tal cual. */
export async function resolveAccountChoice(agentId: string, value: string | undefined): Promise<string | undefined> {
  if (!isPoolValue(value)) return value;
  return (await poolPick(agentId, poolNameOf(value))) ?? undefined;
}
