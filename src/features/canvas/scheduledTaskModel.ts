/** Modelo de apresentação das tarefas agendadas. Não compartilha estado com Rotinas. */
export type ScheduledTaskSchedule =
  | { kind: "every"; secs: number }
  | { kind: "daily"; hour: number; minute: number; days: number[] }
  | { kind: "once"; at: number };

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  workspaceId: string | null;
  agentId: string;
  model: string | null;
  effort: string | null;
  /** Conversa existente; `null` cria uma nova conversa supervisionada no despacho. */
  existingThreadId: string | null;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
  nextRun: number | null;
  armedAtMs: number;
  createdAt: number;
  updatedAt: number;
  access: string;
  runs: number;
  lastRun: number | null;
  lastResult: string | null;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  cwd: string;
  agentId: string;
  model: string | null;
  scheduledFor: number | null;
  scheduledAt: number;
  finishedAt: number | null;
  status: "running" | "dispatched" | "failed" | "missed";
  threadId: string | null;
  result: string;
}

/** Payload aceito pelo backend para criar ou alterar uma tarefa. */
export interface ScheduledTaskInput {
  name: string;
  prompt: string;
  cwd: string;
  workspaceId: string | null;
  agentId: string;
  model: string | null;
  effort: string | null;
  existingThreadId: string | null;
  schedule: ScheduledTaskSchedule;
}

export interface TaskThreadTarget {
  id: string;
  title: string;
  cwd: string;
  agentId: string;
  model: string | null;
  effort: string | null;
  state: "active" | "settled";
  updatedAt: number;
}

export interface TaskModelOption {
  id: string;
  label: string;
  reasoningLevels: string[];
}

export type TaskTranslate = (key: string, vars?: Record<string, string | number>) => string;

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function localDateTimeInput(date: Date): string {
  const part = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function describeTaskSchedule(schedule: ScheduledTaskSchedule, t: TaskTranslate): string {
  if (schedule.kind === "once") return t("canvas.scheduledTasks.schedule.once");
  if (schedule.kind === "every") {
    if (schedule.secs % 3600 === 0) return t("canvas.scheduledTasks.schedule.everyHours", { n: schedule.secs / 3600 });
    if (schedule.secs % 60 === 0) return t("canvas.scheduledTasks.schedule.everyMinutes", { n: schedule.secs / 60 });
    return t("canvas.scheduledTasks.schedule.everySeconds", { n: schedule.secs });
  }
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  const days = schedule.days.map((day) => t(`canvas.scheduledTasks.schedule.day${day}`)).join(", ");
  return schedule.days.length === 0
    ? t("canvas.scheduledTasks.schedule.daily", { time })
    : t("canvas.scheduledTasks.schedule.onDays", { time, days });
}
