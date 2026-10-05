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

export type BarrelKind = "approval" | "failing" | "memory" | "ask_timeout";
export interface ArcadeBarrel { kind: BarrelKind; stage: "work" | "tests" | "review"; taskId?: string; count: number; detail?: string }
export interface ArcadeBarrelInput {
  scene: ArcadeScene;
  /** Tarefas da missão com aprovação pendente (broker); `null` = não medido. */
  approvalTaskIds: string[] | null;
  /** Memórias sugeridas sem resposta da missão; `null` = não medido. */
  pendingMemories: number | null;
  /** Spans de `peer_ask` já terminados: `detail === "timeout"` é uma pergunta que ninguém respondeu a tempo. */
  timings: Array<{ kind: string; actor?: string; target?: string; detail?: string }> | null;
}

/** Barris = obstáculos REAIS. Sem fonte medida não se inventa barril: some e o HUD diz "não medido". */
export function deriveBarrels(input: ArcadeBarrelInput): ArcadeBarrel[] {
  const barrels: ArcadeBarrel[] = [];
  for (const taskId of input.approvalTaskIds ?? []) {
    const task = input.scene.tasks.find((item) => item.id === taskId);
    if (task) barrels.push({ kind: "approval", stage: task.stage, taskId, count: 1 });
  }
  for (const task of input.scene.tasks) {
    if (task.status === "failed" || task.checks?.includes("failed")) {
      barrels.push({ kind: "failing", stage: task.checks?.includes("failed") ? "tests" : task.stage, taskId: task.id, count: 1 });
    }
  }
  if ((input.pendingMemories ?? 0) > 0) barrels.push({ kind: "memory", stage: "review", count: input.pendingMemories ?? 0 });
  const timeouts = (input.timings ?? []).filter((span) => span.kind === "peer_ask" && span.detail === "timeout");
  for (const span of timeouts) {
    barrels.push({ kind: "ask_timeout", stage: "work", count: 1, detail: `${span.actor ?? "?"} → ${span.target ?? "?"}` });
  }
  return barrels;
}

export type TrophyStep = "integration_ready" | "integrated";
export interface ArcadeTrophy {
  /** Entrega real da missão: branch de integração pronta e aplicada ao projeto. PR e CI não são medidos pelo app: ficam `null`. */
  step: TrophyStep | null;
  pr: null;
  ci: null;
}
export function deriveTrophy(review: { integrationBranch: string | null; appliedAt: number | null } | null): ArcadeTrophy {
  const step = !review ? null : review.appliedAt !== null ? "integrated" : review.integrationBranch ? "integration_ready" : null;
  return { step, pr: null, ci: null };
}
