import { invoke } from "@tauri-apps/api/core";

import type { BranchInfo, LandPreview, LandResult } from "./floorsModel";
import type { Routine, Schedule } from "./routineModel";
import type { TeamMessage } from "./teamFeedModel";

export interface Floor {
  id: string;
  name: string;
  branch: string;
  cwd: string;
}

/** Andares da pasta (`floor_list`, `ipc/commands/floor.rs`). */
export interface FloorList {
  ground: string;
  floors: Floor[];
}

export interface CreatedFloor {
  id: string;
  name: string;
  branch: string;
  cwd: string;
}

export const floorList = (cwd: string) => invoke<FloorList>("floor_list", { cwd });

export const floorBranches = (cwd: string) => invoke<BranchInfo[]>("floor_branches", { cwd });

export const floorLandPreview = (id: string, target: string | null) =>
  invoke<LandPreview>("floor_land_preview", { id, target });

export const floorLand = (args: { id: string; target: string; deleteBranch: boolean; discardFloor: boolean }) =>
  invoke<LandResult>("floor_land", args);

export const floorDelete = (id: string) =>
  invoke<{ name: string; branch: string; branchKept: boolean }>("floor_delete", { id });

export const floorCreate = (args: {
  cwd: string;
  name: string;
  from: string | null;
  existingBranch: string | null;
  exclude: string[];
}) => invoke<CreatedFloor>("floor_create", args);

/** Imagens coladas no canvas, guardadas em `~/.ags/canvas-assets/` (`canvas/mod.rs`). */
export const canvasAssetLoad = (id: string) => invoke<string>("canvas_asset_load", { id });

export const canvasAssetSave = (data: string) => invoke<string>("canvas_asset_save", { data });

/** Mensagens da equipe da missão depois de `afterId` (`missions/messages.rs`). */
export const missionMessages = (missionId: string, afterId: number) =>
  invoke<TeamMessage[]>("mission_messages", { missionId, afterId });

/** Fala da pessoa com um agente do canvas (`ags say`; `chat.rs`). */
export const chatSend = (tabId: string, thread: string, text: string) => invoke<void>("chat_send", { tabId, thread, text });

/** Rotinas (`ipc/commands/routine.rs`). */
export const routineListAll = () => invoke<Routine[]>("routine_list_all");

export const routineSetEnabled = (id: string, enabled: boolean) => invoke<void>("routine_set_enabled", { id, enabled });

export const routineSetCatchUp = (id: string, catchUp: boolean) => invoke<void>("routine_set_catch_up", { id, catchUp });

export const routineRunNow = (id: string) => invoke<void>("routine_run_now", { id });

export const routineRemove = (id: string) => invoke<void>("routine_remove", { id });

export const routineCreateUi = (args: { name: string; text: string; schedule: Schedule; targetTab: string | null; catchUp: boolean }) =>
  invoke<void>("routine_create_ui", args);
