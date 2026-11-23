import { create } from "zustand";

import { uiErrorText } from "@/shared/uiErrorText";

import * as ipc from "./ipc";
import type { MemorySyncStatus } from "./types";

interface MemorySyncState {
  status: MemorySyncStatus | null;
  running: boolean;
  error: string | null;
  load: () => Promise<void>;
  setup: (accountId: string, repoName: string, cwd: string) => Promise<void>;
  setEnabled: (enabled: boolean, cwd: string) => Promise<void>;
  setAuto: (autoEnabled: boolean, intervalHours: number) => Promise<void>;
  syncNow: (workspaceId: string | null, cwd: string) => Promise<void>;
  restoreNow: (cwd: string) => Promise<void>;
  resolveConflict: (workspaceId: string | null, cwd: string, path: string, useRemote: boolean) => Promise<void>;
}

export const useMemorySyncStore = create<MemorySyncState>()((set, get) => ({
  status: null,
  running: false,
  error: null,

  load: async () => {
    const status = await ipc.memorySyncStatus();
    set({ status, error: status.lastError });
  },

  setup: async (accountId, repoName, cwd) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const status = await ipc.memorySyncSetup(accountId, repoName, cwd);
      set({ status, error: status.lastError });
    } catch (cause) {
      await get().load().catch(() => {});
      set({ error: uiErrorText(cause) });
    } finally {
      set({ running: false });
    }
  },

  setEnabled: async (enabled, cwd) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const status = await ipc.memorySyncSetEnabled(enabled, cwd);
      set({ status, error: status.lastError });
    } catch (cause) {
      await get().load().catch(() => {});
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

  restoreNow: async (cwd) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const result = await ipc.memorySyncRestoreNow(cwd);
      set({ status: result.status, error: result.status.lastError });
    } catch (cause) {
      set({ error: uiErrorText(cause) });
      await get().load().catch(() => {});
    } finally {
      set({ running: false });
    }
  },

  resolveConflict: async (workspaceId, cwd, path, useRemote) => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const result = await ipc.memorySyncResolveConflict(workspaceId, cwd, path, useRemote);
      set({ status: result.status, error: result.status.lastError });
    } catch (cause) {
      set({ error: uiErrorText(cause) });
      await get().load().catch(() => {});
    } finally {
      set({ running: false });
    }
  },
}));
