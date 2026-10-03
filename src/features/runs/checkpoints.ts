import { invoke } from "@tauri-apps/api/core";

export type CheckpointKind = "before" | "after" | "manual" | "safety";

/** Una foto del trabajo de un run (ver `runs/checkpoints.rs`). */
export interface Checkpoint {
  id: string;
  runId: string;
  taskId: string | null;
  kind: CheckpointKind;
  dir: string;
  commitSha: string;
  headSha: string | null;
  label: string;
  createdAt: number;
}

export interface RollbackPreview {
  /** Las tareas que vuelven a la cola; la pedida, primero. */
  tasks: { id: string; title: string; status: string }[];
  dirs: string[];
  withoutCheckpoint: string[];
}

export const runCheckpoints = (runId: string) => invoke<Checkpoint[]>("run_checkpoints", { runId });
export const rollbackPreview = (taskId: string) => invoke<RollbackPreview>("run_rollback_preview", { taskId });
export const rollbackTask = (taskId: string) => invoke<string[]>("run_rollback", { taskId });
export const createCheckpoint = (runId: string, label: string) => invoke<Checkpoint>("run_checkpoint_create", { runId, label });
export const restoreCheckpoint = (id: string) => invoke<void>("run_restore_checkpoint", { id });

/** Las fotos desde las que tiene sentido restaurar a mano: las de seguridad y las manuales. */
export const restorable = (list: Checkpoint[]): Checkpoint[] =>
  list.filter((c) => c.kind === "safety" || c.kind === "manual").sort((a, b) => b.createdAt - a.createdAt);

/** ¿Se puede ofrecer "volver atrás" en esta tarea? Terminada y no es el líder (que solo planifica). */
export function canRollback(task: { status: string; role: string | null }): boolean {
  return ["done", "failed", "cancelled", "skipped"].includes(task.status) && task.role !== "lead";
}
