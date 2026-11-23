/** Comandos Tauri de sincronização de memória (`src-tauri/src/memory_sync/commands.rs`). */
import { invoke } from "@tauri-apps/api/core";

import type { MemorySyncResult, MemorySyncStatus } from "./types";

export const memorySyncStatus = () => invoke<MemorySyncStatus>("memory_sync_status");

export const memorySyncSetup = (accountId: string, repoName: string, cwd: string) =>
  invoke<MemorySyncStatus>("memory_sync_setup", { accountId, repoName, cwd });

export const memorySyncSetEnabled = (enabled: boolean, cwd: string) =>
  invoke<MemorySyncStatus>("memory_sync_set_enabled", { enabled, cwd });

export const memorySyncSetAuto = (autoEnabled: boolean, intervalHours: number) =>
  invoke<MemorySyncStatus>("memory_sync_set_auto", { autoEnabled, intervalHours });

export const memorySyncNow = (workspaceId: string | null, cwd: string | null) =>
  invoke<MemorySyncResult>("memory_sync_now", { workspaceId, cwd });

export const memorySyncRestoreNow = (cwd: string) =>
  invoke<MemorySyncResult>("memory_sync_restore_now", { cwd });

export const memorySyncResolveConflict = (
  workspaceId: string | null,
  cwd: string,
  path: string,
  useRemote: boolean,
) => invoke<MemorySyncResult>("memory_sync_resolve_conflict", { workspaceId, cwd, path, useRemote });
