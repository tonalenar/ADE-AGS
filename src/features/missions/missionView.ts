/**
 * Las piezas puras de la pantalla de misiones: qué acción ofrece cada estado, el avance,
 * el formulario. Sin React, para poder probarlas.
 */
import type { Complexity, PendingApproval, Task, TaskStatus } from "@/features/runs/types";

import type { Mission, MissionInput, MissionStatus } from "./types";

/**
 * La única acción de cada estado. Un borrador se arranca, una que corre se cancela, y una
 * terminada no ofrece nada: reintentar, duplicar o archivar quedan para otra etapa.
 */
export function missionAction(status: MissionStatus): "start" | "cancel" | null {
  switch (status) {
    case "draft":
      return "start";
    case "running":
      return "cancel";
    default:
      return null;
  }
}

/** Solo un borrador se reconfigura: lo demás describe cómo se ejecutó. */
export const canEdit = (status: MissionStatus) => status === "draft";

export type Progress = { kind: "planning" } | { kind: "workers"; done: number; total: number };

const LIVE: ReadonlySet<TaskStatus> = new Set(["pending", "ready", "running"]);

/**
 * El avance de una misión, sin el lead: "2 / 3 workers listos", o "el lead está
 * planificando" mientras todavía no repartió nada. `null` = nada que mostrar (un borrador,
 * o una que terminó sin llegar a repartir).
 */
export function progressOf(s: { workersDone: number; workersTotal: number; leadStatus: TaskStatus | null }): Progress | null {
  if (s.workersTotal > 0) return { kind: "workers", done: s.workersDone, total: s.workersTotal };
  return s.leadStatus && LIVE.has(s.leadStatus) ? { kind: "planning" } : null;
}

/** Las tareas del run que no son el lead. */
export const workersOf = (tasks: Task[]) => tasks.filter((t) => t.role !== "lead");

/**
 * Lo que está haciendo cada agente, derivado de su tarea y de la cola de permisos. Es
 * estado de pantalla: en la base la tarea sigue `running` o `pending`.
 */
export type AgentState = "working" | "waiting_approval" | "waiting_deps" | "queued" | "done" | "failed" | "stopped";

export const AGENT_STATES: AgentState[] = ["working", "waiting_approval", "waiting_deps", "queued", "done", "failed", "stopped"];

/**
 * `blocked` = ids de tareas con un permiso esperando. `tasks` son las del mismo run, para
 * saber si una pendiente espera a otra o solo un lugar libre.
 */
export function agentStateOf(task: Task, tasks: Task[] = [], blocked: ReadonlySet<string> = new Set()): AgentState {
  if (blocked.has(task.id)) return "waiting_approval";
  switch (task.status) {
    case "ready":
    case "running":
      return "working";
    case "pending": {
      const unfinished = task.dependsOn.some((id) => tasks.find((t) => t.id === id)?.status !== "done");
      return unfinished ? "waiting_deps" : "queued";
    }
    case "done":
      return "done";
    case "failed":
    case "skipped":
      return "failed";
    default:
      return "stopped";
  }
}

/** Cuántas de estas tareas hay en cada estado. */
export function countAgentStates(tasks: Task[], blocked: ReadonlySet<string> = new Set()): Record<AgentState, number> {
  const counts = Object.fromEntries(AGENT_STATES.map((s) => [s, 0])) as Record<AgentState, number>;
  for (const t of tasks) counts[agentStateOf(t, tasks, blocked)] += 1;
  return counts;
}

// ── Permisos ───────────────────────────────────────────────────
// La cola es la del broker, la misma que ve la flota (`useRunsStore.approvals`): acá solo
// se filtra, nunca se copia.

/** Los permisos que esperan en estas tareas, el más viejo primero. */
export function approvalsFor(approvals: PendingApproval[], tasks: Task[]): PendingApproval[] {
  const ids = new Set(tasks.map((t) => t.id));
  return approvals.filter((a) => ids.has(a.taskId)).sort((a, b) => a.askedAt - b.askedAt);
}

/** Los runs que tienen alguna tarea esperando un permiso. */
export function blockedRuns(approvals: PendingApproval[], tasks: Task[]): Set<string> {
  const runOf = new Map(tasks.map((t) => [t.id, t.runId]));
  const runs = new Set<string>();
  for (const a of approvals) {
    const run = runOf.get(a.taskId);
    if (run) runs.add(run);
  }
  return runs;
}

/** Lo que se muestra como estado: el de la base, salvo una misión en curso que espera a alguien. */
export type MissionPhase = MissionStatus | "waiting_approval";

export function missionPhase(status: MissionStatus, waitingApproval: boolean): MissionPhase {
  return status === "running" && waitingApproval ? "waiting_approval" : status;
}

/** Los nombres de las tareas de las que depende, como las nombra el plan. */
export function dependencyLabels(task: Task, tasks: Task[]): string[] {
  return task.dependsOn.map((id) => {
    const dep = tasks.find((t) => t.id === id);
    return dep ? (dep.planKey ?? dep.title) : id.slice(0, 8);
  });
}

// ── El formulario ──────────────────────────────────────────────

/** Cómo se elige el modelo del lead: por complejidad (decide el ruteo) o uno fijo. */
export type ModelMode = Complexity | "fixed";

export interface MissionForm {
  title: string;
  objective: string;
  cwd: string;
  mode: ModelMode;
  agentId: string;
  model: string;
  autoAccount: boolean;
  /** Con `autoAccount = false`. `null` = la del sistema. */
  accountId: string | null;
  maxParallel: number;
  budget: string;
}

/** Un borrador nuevo: el lead en `hard` y la cuenta que elija el ruteo, como en la flota. */
export function emptyForm(cwd: string): MissionForm {
  return {
    title: "",
    objective: "",
    cwd,
    mode: "hard",
    agentId: "claude-code",
    model: "",
    autoAccount: true,
    accountId: null,
    maxParallel: 2,
    budget: "",
  };
}

export function formFromMission(m: Mission): MissionForm {
  const fixed = m.leadAgentId !== null && m.complexity === null;
  return {
    title: m.title,
    objective: m.objective,
    cwd: m.cwd,
    mode: fixed ? "fixed" : (m.complexity ?? "hard"),
    agentId: m.leadAgentId ?? "claude-code",
    model: m.leadModel ?? "",
    autoAccount: m.autoAccount,
    accountId: m.leadAccountId,
    maxParallel: m.maxParallel,
    budget: m.budgetUsd === null ? "" : String(m.budgetUsd),
  };
}

/** Un presupuesto vacío o ilegible es "sin tope", no cero: cero no dejaría hacer nada. */
export function parseBudget(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Lo que falta para poder guardar. El backend valida igual; esto es para el botón. */
export function missingFields(form: MissionForm): Array<"title" | "objective" | "cwd"> {
  const missing: Array<"title" | "objective" | "cwd"> = [];
  if (!form.title.trim()) missing.push("title");
  if (!form.objective.trim()) missing.push("objective");
  if (!form.cwd.trim()) missing.push("cwd");
  return missing;
}

export function toInput(form: MissionForm): MissionInput {
  const fixed = form.mode === "fixed";
  return {
    title: form.title.trim(),
    objective: form.objective.trim(),
    cwd: form.cwd.trim(),
    maxParallel: form.maxParallel,
    budgetUsd: parseBudget(form.budget),
    // Con complejidad no se fija el agente: el ruteo decide cuál conviene.
    leadAgentId: fixed ? form.agentId : null,
    leadModel: fixed ? form.model || null : null,
    leadAccountId: form.autoAccount ? null : form.accountId,
    autoAccount: form.autoAccount,
    complexity: form.mode === "fixed" ? null : form.mode,
  };
}
