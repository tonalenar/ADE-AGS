import { create } from "zustand";

import * as ipc from "./ipc";
import type { PrelaunchPreset } from "./types";

interface PrelaunchState {
  presets: PrelaunchPreset[];
  loaded: boolean;
  /** Por que a última leitura falhou (`null` = não falhou). Sem ele, a falha parecia "preset ausente". */
  loadError: string | null;

  load: () => Promise<void>;
  save: (draft: { id?: string; name: string; command: string }) => Promise<PrelaunchPreset>;
  remove: (id: string) => Promise<void>;
}

export const usePrelaunchStore = create<PrelaunchState>()((set, get) => ({
  presets: [],
  loaded: false,
  loadError: null,

  load: async () => {
    try {
      set({ presets: await ipc.listPresets(), loaded: true, loadError: null });
    } catch (cause) {
      // `loaded` fica como estava: a lista não é "vazia", ela não foi lida.
      set({ loadError: String(cause) });
      throw cause;
    }
  },

  save: async (draft) => {
    const preset = await ipc.savePreset(draft);
    await get().load();
    return preset;
  },

  remove: async (id) => {
    await ipc.deletePreset(id);
    await get().load();
  },
}));
