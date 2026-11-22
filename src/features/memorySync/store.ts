import { create } from "zustand";

import { uiErrorText } from "@/shared/uiErrorText";

import * as ipc from "./ipc";
import type { MemorySyncStatus } from "./types";

interface MemorySyncState {
  status: MemorySyncStatus | null;
  running: boolean;
  error: string | null;
  load: () => Promise<void>;
  setup: (accountId: string, repoName: string) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setAuto: (autoEnabled: boolean, intervalHours: number) => Promise<void>;
  syncNow: (workspaceId: string | null, cwd: string) => Promise<void>;
}

export const useMemorySyncStore = create<MemorySyncState>()((set, get) => ({
  status: null,
  running: false,
  error: null,

  load: async () => {
    const status = await ipc.memorySyncStatus();
    set({ status, error: status.lastError });
  },

  setup: async (accountId, repoName) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const status = await ipc.memorySyncSetup(accountId, repoName);
      set({ status, error: status.lastError });
    } catch (cause) {
      set({ error: uiErrorText(cause) });
    } finally {
      set({ running: false });
    }
  },

  setEnabled: async (enabled) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const status = await ipc.memorySyncSetEnabled(enabled);
      set({ status, error: status.lastError });
    } catch (cause) {
      set({ error: uiErrorText(cause) });
    } finally {
      set({ running: false });
    }
  },

  setAuto: async (autoEnabled, intervalHours) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const status = await ipc.memorySyncSetAuto(autoEnabled, intervalHours);
      set({ status, error: status.lastError });
    } catch (cause) {
      set({ error: uiErrorText(cause) });
    } finally {
      set({ running: false });
    }
  },

  syncNow: async (workspaceId, cwd) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const result = await ipc.memorySyncNow(workspaceId, cwd || null);
      set({ status: result.status, error: result.status.lastError });
    } catch (cause) {
      set({ error: uiErrorText(cause) });
      await get().load().catch(() => {});
    } finally {
      set({ running: false });
    }
  },
}));
