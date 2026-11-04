import { invoke } from "@tauri-apps/api/core";

import type { IntegrationConflicts, ScopeOverlap } from "./conflictsTypes";

export const missionConflicts = (missionId: string) => invoke<IntegrationConflicts>("mission_conflicts", { missionId });
export const resolveMissionConflict = (missionId: string, path: string, content: string) =>
  invoke<IntegrationConflicts>("mission_resolve_conflict", { missionId, path, content });
/** Concluye el merge (commit) o, con `abort`, lo cancela y deja la integración como estaba. */
export const concludeMissionMerge = (missionId: string, abort = false) =>
  invoke<void>("mission_conclude_merge", { missionId, abort });

/** As tarefas em andamento da missão (terminais e frota) com escopos de escrita sobrepostos. Só aviso. */
export const missionScopeOverlaps = (missionId: string) => invoke<ScopeOverlap[]>("mission_scope_overlaps", { missionId });
