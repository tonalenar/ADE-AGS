import { create } from "zustand";

import { accountEnv, codexAccountUsage, discoverAntigravityAccount } from "@/features/accounts/ipc";
import type { AgentAccount, CodexUsage } from "@/features/accounts/types";
import { modelMeters, type ModelMeter } from "./antigravityQuota";
import { agentAccountUsage, claudeLiveUsage, isUsageFresh, planLabel, type LiveUsage } from "@/features/accounts/usage";

/** Cada cuánto se renuevan las cuotas mientras el canvas está abierto. */
const EVERY = 5 * 60 * 1000;

const isSystem = (a: AgentAccount) => a.id.startsWith("system:");

export interface CodexEntry {
  usage: CodexUsage | null;
  failed: boolean;
}

export interface AntigravityEntry {
  /** `null` = todavía no se supo. Los más gastados primero (ver `modelMeters`). */
  meters: ModelMeter[] | null;
  failed: boolean;
  /** Epoch en segundos de la última consulta buena; 0 = ninguna. */
  fetchedAt: number;
}

interface UsageState {
  claude: Record<string, LiveUsage>;
  codex: Record<string, CodexEntry>;
  antigravity: Record<string, AntigravityEntry>;
  plan: Record<string, string | null>;
  busy: Record<string, boolean>;
  refresh: (account: AgentAccount, force: boolean) => Promise<void>;
}

const patch = <K extends "claude" | "codex" | "plan" | "busy" | "antigravity">(key: K, id: string, value: UsageState[K][string]) =>
  (s: UsageState) => ({ [key]: { ...s[key], [id]: value } }) as unknown as Pick<UsageState, K>;

/**
 * Las cuotas de todas las cuentas, en un solo lugar y siempre vivas: los anillos de la
 * barra y el panel leen de acá, así que abrir o cerrar el panel no vuelve a preguntar ni
 * lo deja en blanco.
 */
export const useUsageStore = create<UsageState>((set, get) => ({
  claude: {},
  codex: {},
  antigravity: {},
  plan: {},
  busy: {},

  async refresh(account, force) {
    const id = account.id;
    set(patch("busy", id, true));
    try {
      if (account.agentId === "claude-code") {
        const env = isSystem(account) ? {} : await accountEnv(id);
        let live = await claudeLiveUsage(id, env, force);
        set(patch("claude", id, live));
        // Lo guardado puede estar vencido: se muestra al instante y se pregunta de verdad detrás.
        if (!force && live.available && live.cached && !isUsageFresh(live.fetchedAt, Math.floor(Date.now() / 1000))) {
          live = await claudeLiveUsage(id, env, true);
          set(patch("claude", id, live));
        }
        if (get().plan[id] === undefined) {
          try {
            const u = await agentAccountUsage(account.agentId, isSystem(account) ? null : id);
            set(patch("plan", id, planLabel(u.plan.tier)));
          } catch {
            /* sin plan: queda sin sello */
          }
        }
      } else if (account.agentId === "codex") {
        try {
          set(patch("codex", id, { usage: await codexAccountUsage(id), failed: false }));
        } catch {
          set(patch("codex", id, { usage: get().codex[id]?.usage ?? null, failed: true }));
        }
      } else if (account.agentId === "antigravity") {
        // Dos HTTP por cuenta (ver `antigravity_access.rs`): barato, va en paralelo con las demás.
        try {
          const discovery = await discoverAntigravityAccount(id);
          set(patch("antigravity", id, { meters: modelMeters(discovery.models), failed: false, fetchedAt: Math.floor(Date.now() / 1000) }));
        } catch {
          // Se conserva el último valor bueno, como en Codex.
          const prev = get().antigravity[id];
          set(patch("antigravity", id, { meters: prev?.meters ?? null, failed: true, fetchedAt: prev?.fetchedAt ?? 0 }));
        }
      }
    } catch (e) {
      if (account.agentId === "claude-code") {
        set(patch("claude", id, { available: false, session: null, week: null, weekModels: [], fetchedAt: 0, cached: false, problem: String(e) }));
      }
    } finally {
      set(patch("busy", id, false));
    }
  },
}));

let timer: number | undefined;
let running = "";

/**
 * Arranca (o rearma, si cambian las cuentas) la renovación periódica. Las de Claude van de
 * una en una —cada consulta levanta una TUI— y las demás en paralelo.
 */
export function startUsagePolling(accounts: AgentAccount[]): void {
  const sig = accounts.map((a) => a.id).join("|");
  if (sig === running && timer !== undefined) return;
  running = sig;
  window.clearInterval(timer);
  const sweep = async () => {
    const { refresh } = useUsageStore.getState();
    await Promise.all(
      accounts.filter((a) => a.agentId === "codex" || a.agentId === "antigravity").map((a) => refresh(a, true)),
    );
    for (const a of accounts.filter((x) => x.agentId === "claude-code")) await refresh(a, false);
  };
  void sweep();
  timer = window.setInterval(() => void sweep(), EVERY);
}
