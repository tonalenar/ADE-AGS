import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRun, TaskThreadTarget } from "./scheduledTaskModel";

export const listScheduledTasks = () => invoke<ScheduledTask[]>("scheduled_task_list");
export const createScheduledTask = (input: ScheduledTaskInput) =>
  invoke<ScheduledTask>("scheduled_task_create", { input });
export const updateScheduledTask = (id: string, input: ScheduledTaskInput) =>
  invoke<ScheduledTask>("scheduled_task_update", { id, input });
export const setScheduledTaskEnabled = (id: string, enabled: boolean) =>
  invoke<ScheduledTask>("scheduled_task_set_enabled", { id, enabled });
export const runScheduledTaskNow = (id: string) => invoke<ScheduledTaskRun>("scheduled_task_run_now", { id });
export const deleteScheduledTask = (id: string) => invoke<boolean>("scheduled_task_delete", { id });
export const scheduledTaskHistory = (taskId: string) => invoke<ScheduledTaskRun[]>("scheduled_task_history", { taskId });
export const onScheduledTasksChanged = (onChanged: () => void): Promise<UnlistenFn> =>
  listen("cc-scheduled-tasks-changed", () => onChanged());

/** Lê só os campos visíveis do seletor; accountId e outros metadados não entram no estado da UI. */
export async function listTaskThreadTargets(): Promise<TaskThreadTarget[]> {
  const rows = await invoke<Array<{
    id: string;
    title: string;
    cwd: string;
    agentId: string;
    model: string | null;
    effort: string | null;
    state: "active" | "settled";
    updatedAt: number;
  }>>("chat_threads");
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    agentId: row.agentId,
    model: row.model,
    effort: row.effort,
    state: row.state,
    updatedAt: row.updatedAt,
  }));
}
