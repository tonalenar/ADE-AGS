/** Os comandos de `src-tauri/src/tab_checkpoints/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { CaptureResult, CheckpointDiff, RestoreResult, TabCheckpoint } from "./types";

/** `settings`: `"0"` desliga os pontos automáticos. */
export const AUTO_SETTING = "tab_checkpoints_auto";
/** O backend avisa quando a lista de uma aba mudou. */
export const CHANGED_EVENT = "cc-tab-checkpoints-changed";

/** Foto em segundo plano (Enter visto no terminal). Não espera a foto. */
export const tabCheckpointAuto = (tabId: string, cwd: string, message: string, author: string) =>
  invoke<void>("tab_checkpoint_auto", { tabId, cwd, message, author });

export const tabCheckpointCreate = (tabId: string, cwd: string, label?: string) =>
  invoke<CaptureResult>("tab_checkpoint_create", { tabId, cwd, label: label ?? null });

export const tabCheckpointsList = (tabId: string) => invoke<TabCheckpoint[]>("tab_checkpoints_list", { tabId });

export const tabCheckpointDiff = (id: string) => invoke<CheckpointDiff>("tab_checkpoint_diff", { id });

export const tabCheckpointRestore = (id: string, force: boolean) =>
  invoke<RestoreResult>("tab_checkpoint_restore", { id, force });

export const tabCheckpointsDelete = (tabId: string) => invoke<number>("tab_checkpoints_delete", { tabId });

export const tabCheckpointsPrune = () => invoke<number>("tab_checkpoints_prune");
