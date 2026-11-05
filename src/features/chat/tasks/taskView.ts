import { stopRoute, type BgTask, type TaskStatus } from "./tasksModel";

/** O tom de cada status (tokens do tema, sem cor solta). */
export const STATUS_TONE: Record<TaskStatus, string> = {
  running: "text-accent-600 dark:text-accent-400",
  completed: "text-emerald-700 dark:text-emerald-400",
  failed: "text-red-700 dark:text-red-400",
  stopped: "text-gray-500 dark:text-white/50",
  lost: "text-amber-700 dark:text-amber-400",
};

type Translate = (k: string, v?: Record<string, unknown>) => string;

/** O botão de parar: ligado com o nome da tarefa, ou desligado com o porquê (o motor não para uma tarefa só). Pura. */
export function stopLabel(task: BgTask, threadId: string | null, t: Translate): { enabled: boolean; label: string } {
  const route = stopRoute(task, threadId);
  if (route.kind === "none") return { enabled: false, label: t("chat.tasks.stopEngine") };
  return { enabled: true, label: t("chat.tasks.stop", { title: task.title || t("chat.tasks.untitled") }) };
}
