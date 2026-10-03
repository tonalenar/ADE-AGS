import { create } from "zustand";

import * as memoryIpc from "./ipc";
import type { MemoryPendingCounts } from "./types";

interface MemoryPendingState {
  counts: MemoryPendingCounts;
  load: (workspaceId: string) => Promise<MemoryPendingCounts>;
}

export const usePendingMemoryStore = create<MemoryPendingState>((set) => ({
  counts: { workspace: 0, byMission: {} },
  load: async (workspaceId) => {
    const counts = await memoryIpc.getPendingCounts(workspaceId);
    set({ counts });
    return counts;
  },
}));
