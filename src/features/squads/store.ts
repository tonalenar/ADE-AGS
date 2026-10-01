import { create } from "zustand";

import * as ipc from "./ipc";
import type { FunctionalRole, Squad, SquadInput } from "./types";

interface SquadsState {
  squads: Squad[];
  roles: FunctionalRole[];
  loaded: boolean;
  load: () => Promise<void>;
  loadRoles: () => Promise<void>;
  create: (input: SquadInput) => Promise<Squad>;
  update: (squadId: string, input: SquadInput) => Promise<Squad>;
  remove: (squadId: string) => Promise<void>;
}

export const useSquadsStore = create<SquadsState>((set, get) => ({
  squads: [],
  roles: [],
  loaded: false,
  load: async () => set({ squads: await ipc.listSquads(), loaded: true }),
  loadRoles: async () => set({ roles: await ipc.listFunctionalRoles() }),
  create: async (input) => {
    const squad = await ipc.createSquad(input);
    await get().load();
    return squad;
  },
  update: async (squadId, input) => {
    const squad = await ipc.updateSquad(squadId, input);
    await get().load();
    return squad;
  },
  remove: async (squadId) => {
    await ipc.deleteSquad(squadId);
    await get().load();
  },
}));
