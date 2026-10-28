/** As chamadas ao backend da comparação de modelos (`src-tauri/src/compare/commands.rs`). */
import { invoke } from "@tauri-apps/api/core";

import type { Comparison, DiffView, EntryStatus, FinishReport, PreparedComparison, RemoveReport, RepoCheck } from "./types";

export const compareCheck = (cwd: string) => invoke<RepoCheck>("compare_check", { cwd });

export const comparePrepare = (args: { cwd: string; title: string; picks: { pick: string; label: string; agentId: string }[]; isolate: boolean }) =>
  invoke<PreparedComparison>("compare_prepare", args);

export const compareAttach = (id: string, tabs: { pick: string; tabId: string }[]) => invoke<Comparison>("compare_attach", { id, tabs });

export const compareList = () => invoke<Comparison[]>("compare_list");

export const compareStatus = (id: string) => invoke<EntryStatus[]>("compare_status", { id });

export const compareDiff = (id: string, pick: string) => invoke<DiffView>("compare_diff", { id, pick });

export const compareKeep = (id: string, pick: string) => invoke<Comparison>("compare_keep", { id, pick });

export const compareRemove = (id: string, picks: string[], discard: boolean, dryRun: boolean) =>
  invoke<RemoveReport>("compare_remove", { id, picks, discard, dryRun });

export const compareFinish = (id: string, commitPending: boolean, dryRun: boolean) =>
  invoke<FinishReport>("compare_finish", { id, commitPending, dryRun });
