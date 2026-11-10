import { create } from "zustand";

import { getSetting, setSetting } from "@/shared/ipc/settings";

import { DISABLED_KEY, parseDisabled, withEnabled } from "./providersModel";

interface ProvidersState {
  /** Ids dos agentes que o usuário desligou: somem dos seletores de novas abas. */
  disabled: string[];
  loaded: boolean;
  load: () => Promise<void>;
  setEnabled: (agentId: string, enabled: boolean) => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>()((set, get) => ({
  disabled: [],
  loaded: false,

  load: async () => {
    const raw = await getSetting(DISABLED_KEY).catch(() => null);
    set({ disabled: parseDisabled(raw), loaded: true });
  },

  setEnabled: async (agentId, enabled) => {
    const next = withEnabled(get().disabled, agentId, enabled);
    set({ disabled: next });
    try {
      await setSetting(DISABLED_KEY, JSON.stringify(next));
    } catch (e) {
      // Não gravou: volta ao que estava, para a tela não mentir.
      set({ disabled: withEnabled(next, agentId, !enabled) });
      throw e;
    }
  },
}));
