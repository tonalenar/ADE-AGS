import { invoke } from "@tauri-apps/api/core";

import type { IntegrationConflicts } from "./conflictsTypes";

export const missionConflicts = (missionId: string) => invoke<IntegrationConflicts>("mission_conflicts", { missionId });
export const resolveMissionConflict = (missionId: string, path: string, content: string) =>
  invoke<IntegrationConflicts>("mission_resolve_conflict", { missionId, path, content });
export const concludeMissionMerge = (missionId: string) => invoke<void>("mission_conclude_merge", { missionId });
