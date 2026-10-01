/** Comandos de las misiones. Crear y editar solo escriben la base; lanzar es `startMission`. */
import { invoke } from "@tauri-apps/api/core";

import type { Mission, MissionDetail, MissionInput, MissionSummary } from "./types";

export const listMissions = (workspaceId: string) =>
  invoke<MissionSummary[]>("mission_list", { workspaceId });

export const getMission = (missionId: string) => invoke<MissionDetail>("mission_get", { missionId });

export const createMission = (workspaceId: string, input: MissionInput) =>
  invoke<Mission>("mission_create", { workspaceId, input });

/** En borrador cambia todo; después de arrancar, solo el título. */
export const updateMission = (missionId: string, input: MissionInput) =>
  invoke<Mission>("mission_update", { missionId, input });

/** Starts a draft or retries a failed mission in a new run, preserving earlier attempts. */
export const startMission = (missionId: string) => invoke<Mission>("mission_start", { missionId });

/** Un borrador se marca cancelado; una que corre cancela su run. */
export const cancelMission = (missionId: string) => invoke<Mission>("mission_cancel", { missionId });
