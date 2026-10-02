import { create } from "zustand";

import * as ipc from "./ipc";
import type { AccountCapableAgent, AccountHealth, AgentAccount } from "./types";

interface AccountsState {
  accounts: AgentAccount[];
  systemAccounts: AgentAccount[];
  capable: AccountCapableAgent[];
  loaded: boolean;

  load: () => Promise<void>;
  create: (agentId: string, name: string) => Promise<AgentAccount>;
  createWithApiKey: (agentId: string, name: string, apiKey: string, baseUrl: string | null) => Promise<AgentAccount>;
  /** La última verificación de cada cuenta (por id), mientras dura la sesión. */
  health: Record<string, AccountHealth | "checking">;
  checkHealth: (accountId: string) => Promise<AccountHealth>;
  remove: (id: string, deleteFiles: boolean) => Promise<void>;
  /** Variables con las que hay que lanzar un proceso para que corra con esta cuenta. */
  envFor: (accountId: string) => Promise<Record<string, string>>;
}

export const useAccountsStore = create<AccountsState>()((set, get) => ({
  accounts: [],
  systemAccounts: [],
  capable: [],
  loaded: false,

  load: async () => {
    // El estado de login se lee del disco en cada consulta (no se cachea en la base): el
    // login pasa dentro de la TUI, fuera del alcance de la app, y puede caducar sin aviso.
    const [accounts, capable, systemAccounts] = await Promise.all([
      ipc.listAccounts(), ipc.listCapableAgents(), ipc.listSystemAccounts(),
    ]);
    set({ accounts, capable, systemAccounts, loaded: true });
  },

  create: async (agentId, name) => {
    const account = await ipc.createAccount(agentId, name);
    await get().load();
    return account;
  },

  createWithApiKey: async (agentId, name, apiKey, baseUrl) => {
    const account = await ipc.createApiKeyAccount(agentId, name, apiKey, baseUrl);
    await get().load();
    return account;
  },

  health: {},

  checkHealth: async (accountId) => {
    set((s) => ({ health: { ...s.health, [accountId]: "checking" } }));
    try {
      const result = await ipc.accountHealth(accountId);
      set((s) => ({ health: { ...s.health, [accountId]: result } }));
      return result;
    } catch (e) {
      const failed: AccountHealth = { status: "unknown", detail: String(e), email: null, plan: null, checkedAt: Date.now() / 1000 };
      set((s) => ({ health: { ...s.health, [accountId]: failed } }));
      return failed;
    }
  },

  remove: async (id, deleteFiles) => {
    await ipc.deleteAccount(id, deleteFiles);
    await get().load();
  },

  envFor: (accountId) => ipc.accountEnv(accountId),
}));
