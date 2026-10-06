export const LIVE_STAGE_IDS = ["opening", "work", "tests", "review", "delivery"] as const;
export type ArcadeStageId = (typeof LIVE_STAGE_IDS)[number];
export type ArcadeStageStatus = "unknown" | "active" | "done" | "blocked" | "failed";
export type ArcadeTaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "cancelled" | "handed_off" | "skipped";
export interface ArcadeTask {
  id: string; title: string; status: ArcadeTaskStatus; role?: string | null; dependsOn: string[];
  checks?: Array<"passed" | "failed" | "not_run">; attempt?: number;
  /** Elo real com um terminal: a sessão que a tarefa lançou. */
  sessionId?: string | null;
  /** Nomes com que o plano chama a tarefa (planKey, papel funcional): casam com o nome do terminal. */
  aliases?: string[];
  endedAt?: number | null;
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
export interface ArcadeBarrel {
  kind: BarrelKind; stage: "work" | "tests" | "review"; taskId?: string; count: number; detail?: string;
  /** Nome do terminal que espera (quem perguntou, no `peer ask` expirado). */
  heroName?: string;
}
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
    barrels.push({ kind: "ask_timeout", stage: "work", count: 1, detail: `${span.actor ?? "?"} → ${span.target ?? "?"}`, heroName: span.actor });
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

export type AgentKind = "claude" | "codex" | "antigravity" | "gemini" | "opencode" | "generic";
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "powershell", "pwsh", "cmd", "shell"]);
export function agentKind(id: string): AgentKind | null {
  const value = id.toLowerCase();
  if (value.includes("claude")) return "claude";
  if (value.includes("codex")) return "codex";
  if (value.includes("antigravity") || value === "agy") return "antigravity";
  if (value.includes("gemini")) return "gemini";
  if (value.includes("opencode")) return "opencode";
  // Outro agente (não um shell): aparece com o logo genérico em vez de sumir.
  return !value || SHELLS.has(value) ? null : "generic";
}

export type HeroRole = "lead" | "backend" | "frontend" | "qa" | "review" | "other";
/** Cor por papel: lê o nome do terminal e o papel da tarefa ligada. Sem pista = "other". */
export function roleOf(...texts: Array<string | null | undefined>): HeroRole {
  const text = texts.filter(Boolean).join(" ").toLowerCase();
  if (/orquestrador|orchestrat|\blead\b/.test(text)) return "lead";
  if (/\b(qa|test|tests|testing|tester|quality)\b|teste/.test(text)) return "qa";
  if (/review|revis/.test(text)) return "review";
  if (/backend|back-end|server|\bapi\b|rust|dados|\bdata\b/.test(text)) return "backend";
  if (/frontend|front-end|client|\bui\b|interface|css/.test(text)) return "frontend";
  return "other";
}

export interface ArcadeTabInput { id: string; title: string; agentId: string; sessionId?: string | null }
export type HeroState = "running" | "sleeping" | "stopped";
export interface ArcadeHero {
  tabId: string; name: string; kind: AgentKind; role: HeroRole;
  /** Andar onde trabalha: o da tarefa ligada; sem tarefa ligada não se sabe, então fica no chão (equipe). */
  stage: ArcadeStageId | null; taskId: string | null; state: HeroState;
}

/** Sinais reais por terminal (missões em terminais, sem tasks). */
export interface HeroSignals {
  /** Já escreveu de forma sustentada alguma vez: saiu do briefing/espera. */
  workedTabIds: readonly string[];
  /** Já mandou a entrega final ao orquestrador. */
  deliveredTabIds: readonly string[];
  missionStatus: string;
}

/**
 * Andar de um terminal SEM tarefa ligada, só pelos sinais: sem saída sustentada ainda = Abertura
 * (briefing/aguardando); depois pelo papel (QA = Testes, revisão = Revisão, o resto = Trabalho);
 * entregou ou a missão concluiu = Entrega. Pura.
 */
export function terminalStage(role: HeroRole, worked: boolean, delivered: boolean, missionStatus: string): ArcadeStageId {
  if (delivered || missionStatus === "done") return "delivery";
  if (!worked) return "opening";
  if (role === "qa") return "tests";
  if (role === "review") return "review";
  return "work";
}

const ACTIVE_RANK: Record<string, number> = { running: 0, handed_off: 1, ready: 2, pending: 3 };
/** Tarefa de um terminal: pela sessão que ela lançou ou, na falta, pelo nome do terminal = nome da tarefa no plano. Nada de adivinhar. */
export function taskOfTab<T extends ArcadeTask>(tab: ArcadeTabInput, tasks: T[]): T | null {
  const name = tab.title.trim().toLowerCase();
  const linked = tasks.filter((task) =>
    (!!tab.sessionId && task.sessionId === tab.sessionId)
    || (!!name && (task.aliases ?? []).some((alias) => alias.trim().toLowerCase() === name)));
  if (!linked.length) return null;
  const active = linked.filter((task) => task.status in ACTIVE_RANK)
    .sort((a, b) => ACTIVE_RANK[a.status] - ACTIVE_RANK[b.status]);
  return active[0] ?? linked[linked.length - 1];
}

/** UM herói por terminal da missão (shells ficam de fora). Correr só com saída sustentada; parado "!" com falha ou aprovação pendente; senão dorme. */
export function deriveHeroes(input: {
  tabs: ArcadeTabInput[]; scene: ArcadeScene; sustainedTabIds: string[]; approvalTaskIds: string[] | null;
  /** Barris reais: o herói que eles travam espera (`!`) até o bloqueio sair. */
  barrels?: ArcadeBarrel[];
  /** Com sinais, o terminal sem tarefa ganha andar; sem eles fica no chão (equipe). */
  signals?: HeroSignals;
}): ArcadeHero[] {
  const sustained = new Set(input.sustainedTabIds);
  const approvals = new Set(input.approvalTaskIds ?? []);
  return input.tabs.flatMap((tab): ArcadeHero[] => {
    const kind = agentKind(tab.agentId);
    if (!kind) return [];
    const task = taskOfTab(tab, input.scene.tasks);
    const name = tab.title.trim().toLowerCase();
    const blocked = (input.barrels ?? []).some((barrel) =>
      (!!task && barrel.taskId === task.id) || (!!barrel.heroName && barrel.heroName.trim().toLowerCase() === name));
    const stopped = blocked || (!!task && (task.status === "failed" || approvals.has(task.id)));
    const state: HeroState = stopped ? "stopped" : sustained.has(tab.id) ? "running" : "sleeping";
    const role = roleOf(tab.title, task?.role);
    const signals = input.signals;
    const delivered = !!signals && signals.deliveredTabIds.includes(tab.id);
    let stage: ArcadeStageId | null = task ? task.stage : null;
    if (signals && delivered) stage = "delivery";
    else if (signals && !task) stage = terminalStage(role, signals.workedTabIds.includes(tab.id) || sustained.has(tab.id), false, signals.missionStatus);
    return [{ tabId: tab.id, name: tab.title, kind, role, stage, taskId: task?.id ?? null, state }];
  });
}

/** O GLITCH, inimigo da fase. A vida dele é REAL: o que ainda falta entregar. Os tiros dos heróis são só cenário. */
export interface ArcadeBoss {
  /** 0..1: fração que ainda falta entregar. */
  hp: number;
  defeated: boolean;
  done: number;
  total: number;
}
/**
 * Vida do GLITCH: tarefas concluídas / planejadas; sem tarefas (missão em terminais), entregas finais
 * recebidas / integrantes da equipe. Missão concluída ou tudo entregue = derrotado. Pura.
 */
export function deriveBoss(input: { missionStatus: string; plannedTasks: number; tower: { done: number }; teamSize: number }): ArcadeBoss {
  const total = input.plannedTasks > 0 ? input.plannedTasks : Math.max(1, input.teamSize);
  const done = Math.min(total, Math.max(0, input.tower.done));
  const defeated = input.missionStatus === "done" || done >= total;
  return { hp: defeated ? 0 : 1 - done / total, defeated, done, total };
}

export type TowerBlockKind = "task" | "integration" | "pr" | "ci";
/** `filled` = entrega real; `empty` = ainda falta; `unmeasured` = o app não mede (cinza, nunca inventado). */
export type TowerBlockState = "filled" | "empty" | "unmeasured";
export interface TowerBlock { id: string; kind: TowerBlockKind; role: HeroRole; state: TowerBlockState }
export interface ArcadeTower {
  /** De baixo para cima: tarefas concluídas (na ordem em que concluíram), tarefas faltantes, integração, PR, CI. */
  blocks: TowerBlock[];
  done: number;
  planned: number;
  /** Pronta quando todas as tarefas planejadas foram entregues e a integração foi aplicada. PR/CI não medidos não contam como verde. */
  complete: boolean;
}

/** Torre da missão: um bloco por tarefa concluída DE VERDADE. `carrying` = tarefas já concluídas cujo bloco ainda está a caminho (o herói o carrega). */
export function deriveTower(input: {
  scene: ArcadeScene; trophy: ArcadeTrophy; carrying?: ReadonlySet<string>;
  /** Entregas finais reais (peer tell de encerramento). Só viram bloco quando a missão não tem tarefas: com tarefas, o bloco já é da tarefa. */
  deliveries?: Array<{ id: string; role: HeroRole }>;
}): ArcadeTower {
  const planned = input.scene.tasks.filter((task) => task.status !== "cancelled" && task.status !== "skipped");
  const isDone = (task: ArcadeTask) => task.status === "done" && !input.carrying?.has(task.id);
  const done = planned.filter(isDone)
    .sort((a, b) => (a.endedAt ?? Infinity) - (b.endedAt ?? Infinity));
  const delivered: TowerBlock[] = planned.length ? [] : (input.deliveries ?? [])
    .filter((item) => !input.carrying?.has(item.id))
    .map((item) => ({ id: item.id, kind: "task" as const, role: item.role, state: "filled" as const }));
  const todo = planned.filter((task) => !isDone(task));
  const block = (task: ArcadeTask, state: TowerBlockState): TowerBlock =>
    ({ id: task.id, kind: "task", role: roleOf(task.role), state });
  const integrated = input.trophy.step === "integrated";
  const blocks: TowerBlock[] = [
    ...delivered,
    ...done.map((task) => block(task, "filled")),
    ...todo.map((task) => block(task, "empty")),
    { id: "integration", kind: "integration", role: "lead", state: integrated ? "filled" : "empty" },
    { id: "pr", kind: "pr", role: "other", state: input.trophy.pr === null ? "unmeasured" : "filled" },
    { id: "ci", kind: "ci", role: "other", state: input.trophy.ci === null ? "unmeasured" : "filled" },
  ];
  const doneCount = done.length + delivered.length;
  const plannedCount = planned.length + delivered.length;
  return { blocks, done: doneCount, planned: plannedCount, complete: plannedCount > 0 && todo.length === 0 && integrated };
}

/** Tarefas que acabaram de virar `done` (antes não eram). Sem leitura anterior não há transição: o que já estava pronto já está na torre. */
export function newlyDone(previous: ReadonlyMap<string, ArcadeTaskStatus> | null, tasks: ArcadeTask[]): string[] {
  if (!previous) return [];
  return tasks.filter((task) => task.status === "done" && previous.has(task.id) && previous.get(task.id) !== "done").map((task) => task.id);
}
