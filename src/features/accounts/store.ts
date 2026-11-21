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
  /** Nome de exibição e cor do selo; recarrega a lista para todos os lugares verem. */
  setIdentity: (accountId: string, displayName: string | null, accentColor: string | null) => Promise<void>;
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
      if (result.status === "ok" || result.status === "not_logged_in" || result.email) {
        void get().load().catch(() => undefined);
      }
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

  setIdentity: async (accountId, displayName, accentColor) => {
    await ipc.accountIdentitySet(accountId, displayName, accentColor);
    await get().load();
  },
}));
