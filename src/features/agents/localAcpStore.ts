import { create } from "zustand";

import * as ipc from "./localAcpIpc";
import type { LocalAcpConfig, LocalAcpDraft, LocalAcpProvider } from "./localAcpIpc";

interface LocalAcpState {
  providers: LocalAcpProvider[];
  loaded: boolean;
  load: () => Promise<void>;
  get: (id: string) => Promise<LocalAcpConfig>;
  save: (draft: LocalAcpDraft) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useLocalAcpStore = create<LocalAcpState>()((set, get) => ({
  providers: [],
  loaded: false,
  load: async () => {
    if (loading) return loading;
    loading = ipc.listLocalAcp().then((providers) => set({ providers, loaded: true })).finally(() => { loading = null; });
    return loading;
  },
  get: (id) => ipc.getLocalAcp(id),
  save: async (draft) => {
    await ipc.upsertLocalAcp(draft);
    set({ loaded: false });
    await get().load();
  },
  remove: async (id) => {
    await ipc.deleteLocalAcp(id);
    set({ loaded: false });
    await get().load();
  },
}));
