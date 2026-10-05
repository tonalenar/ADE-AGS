export const LIVE_STAGE_IDS = ["opening", "work", "tests", "review", "delivery"] as const;
export type ArcadeStageId = (typeof LIVE_STAGE_IDS)[number];
export type ArcadeStageStatus = "unknown" | "active" | "done" | "blocked" | "failed";
export type ArcadeTaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "cancelled" | "handed_off" | "skipped";
export interface ArcadeTask {
  id: string; title: string; status: ArcadeTaskStatus; role?: string | null; dependsOn: string[];
  checks?: Array<"passed" | "failed" | "not_run">; attempt?: number;
}
export interface ArcadeScene {
  stages: Array<{ id: ArcadeStageId; status: ArcadeStageStatus }>;
  currentStage: ArcadeStageId | null;
  tasks: Array<ArcadeTask & { stage: "work" | "tests" | "review" }>;
  dependencies: Array<{ from: string; to: string }>;
}
export interface ArcadeTiming { kind: string; detail?: string }
export interface ArcadeReviewDelivery { review: "accepted" | "rejected" | "conflict" | null }

/** Classifica apenas por papel ou verificações registradas, nunca pelo título. */
export function taskStage(task: ArcadeTask): "work" | "tests" | "review" {
  if (task.checks?.length) return "tests";
  const role = (task.role ?? "").trim().toLowerCase();
  if (/\b(qa|test|tests|testing|tester|quality)\b/.test(role)) return "tests";
  if (role.includes("review")) return "review";
  return "work";
}
function taskStatus(tasks: ArcadeTask[]): ArcadeStageStatus {
  if (!tasks.length) return "unknown";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => ["pending", "ready", "running", "handed_off"].includes(task.status))) return "active";
  if (tasks.every((task) => task.status === "done")) return "done";
  return "blocked";
}
function testsStatus(tasks: ArcadeTask[]): ArcadeStageStatus {
  const checks = tasks.flatMap((task) => task.checks ?? []);
  if (checks.includes("failed")) return "failed";
  if (checks.includes("not_run")) return "blocked";
  if (checks.length) return "done";
  return taskStatus(tasks.filter((task) => taskStage(task) === "tests"));
}
function reviewsStatus(deliveries: ArcadeReviewDelivery[], tasks: ArcadeTask[]): ArcadeStageStatus {
  if (deliveries.length) {
    if (deliveries.some((delivery) => delivery.review === "rejected" || delivery.review === "conflict")) return "failed";
    if (deliveries.every((delivery) => delivery.review === "accepted")) return "done";
    return "active";
  }
  return taskStatus(tasks.filter((task) => taskStage(task) === "review"));
}
/** Deriva cinco andares usando spans, tarefas, revisões e status persistidos da missão. */
export function deriveArcadeScene(input: {
  missionStatus: string; tasks: ArcadeTask[]; timings: ArcadeTiming[] | null; reviews: ArcadeReviewDelivery[] | null;
}): ArcadeScene {
  const opening = (input.timings ?? []).some((span) =>
    span.kind === "boot" || span.kind === "briefing" || (span.kind === "turn" && span.detail === "briefing"));
  const work = taskStatus(input.tasks.filter((task) => taskStage(task) === "work"));
  let delivery: ArcadeStageStatus = "unknown";
  if (input.missionStatus === "done") delivery = "done";
  else if (input.missionStatus === "failed") delivery = "failed";
  else if (input.missionStatus === "cancelled") delivery = "blocked";
  const status: Record<ArcadeStageId, ArcadeStageStatus> = {
    opening: opening ? "done" : "unknown", work, tests: testsStatus(input.tasks),
    review: reviewsStatus(input.reviews ?? [], input.tasks), delivery,
  };
  const order = ["opening", "work", "tests", "review", "delivery"] as const;
  const stages = order.map((id) => ({ id, status: status[id] }));
  const currentStage = stages.find((stage) => ["active", "blocked", "failed"].includes(stage.status))?.id ?? null;
  const tasks = input.tasks.map((task) => ({ ...task, stage: taskStage(task) }));
  const ids = new Set(tasks.map((task) => task.id));
  const dependencies = tasks.flatMap((task) =>
    task.dependsOn.filter((id) => ids.has(id)).map((id) => ({ from: id, to: task.id })));
  return { stages, currentStage, tasks, dependencies };
}
export function retryCount(tasks: ArcadeTask[]): number {
  return tasks.reduce((sum, task) => sum + Math.max(0, (task.attempt ?? 1) - 1), 0);
}
export function failureCount(tasks: ArcadeTask[]): number {
  return tasks.filter((task) => task.status === "failed").length;
}
