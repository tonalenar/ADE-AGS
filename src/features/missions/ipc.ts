/** Comandos de las misiones. Crear y editar solo escriben la base; lanzar es `startMission`. */
import { invoke } from "@tauri-apps/api/core";

import type { MergeOutcome, Mission, MissionDetail, MissionInput, MissionReview, MissionSummary, TerminalDeliveryInput } from "./types";

export const listMissions = (workspaceId: string) =>
  invoke<MissionSummary[]>("mission_list", { workspaceId });

export const getMission = (missionId: string) => invoke<MissionDetail>("mission_get", { missionId });

export const createMission = (workspaceId: string, input: MissionInput) =>
  invoke<Mission>("mission_create", { workspaceId, input });

/** En borrador cambia todo; después de arrancar, solo el título. */
export const updateMission = (missionId: string, input: MissionInput) =>
  invoke<Mission>("mission_update", { missionId, input });

/** Starts a draft or retries a failed mission in a new run, preserving earlier attempts. */
export const startMission = (missionId: string, force = false) =>
  invoke<Mission>("mission_start", { missionId, force });

/** Arranca la misión en terminales: solo la marca en curso (las pestañas las abre la pantalla). */
export const startMissionTerminals = (missionId: string, force = false) =>
  invoke<Mission>("mission_start_terminals", { missionId, force });

export interface DuplicateMissionResult {
  id: string;
  title: string;
  status: string;
  isRunning: boolean;
  isRecent: boolean;
  createdAt: number;
  startedAt: number | null;
}

export const checkMissionDuplicate = (missionId: string) =>
  invoke<DuplicateMissionResult | null>("mission_check_duplicate", { missionId });

export const checkMissionDuplicateInput = (
  workspaceId: string,
  cwd: string,
  title: string,
  objective: string,
  currentId?: string
) =>
  invoke<DuplicateMissionResult | null>("mission_check_duplicate_input", {
    workspaceId,
    cwd,
    title,
    objective,
    currentId,
  });

/** Da por terminada una misión en terminales. */
export const finishMissionTerminals = (missionId: string, delivery: TerminalDeliveryInput) =>
  invoke<Mission>("mission_finish_terminals", { missionId, delivery });

/** Un borrador se marca cancelado; una que corre cancela su run. */
export const cancelMission = (missionId: string) => invoke<Mission>("mission_cancel", { missionId });

/** Lo que entregó cada tarea aislada del run actual (ver `missions::review`). */
export const missionReview = (missionId: string) => invoke<MissionReview>("mission_review", { missionId });
export const missionTaskDiff = (taskId: string) => invoke<string>("mission_task_diff", { taskId });
/** La junta en la integración de la misión; un conflicto se aborta y vuelve en el resultado. */
export const acceptMissionTask = (missionId: string, taskId: string) =>
  invoke<MergeOutcome>("mission_accept_task", { missionId, taskId });
export const rejectMissionTask = (missionId: string, taskId: string) =>
  invoke<void>("mission_reject_task", { missionId, taskId });
/** Un merge de la integración en el proyecto. Se niega con el árbol sucio. */
export const applyMission = (missionId: string) => invoke<MergeOutcome>("mission_apply", { missionId });
