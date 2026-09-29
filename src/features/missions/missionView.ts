/**
 * Las piezas puras de la pantalla de misiones: qué acción ofrece cada estado, el avance,
 * el formulario. Sin React, para poder probarlas.
 */
import type { Complexity, Task } from "@/features/runs/types";

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

/** "3 / 5 tareas listas". `null` = todavía no hay tareas que contar. */
export function progressOf(s: { tasksDone: number; tasksTotal: number }): { done: number; total: number } | null {
  return s.tasksTotal > 0 ? { done: s.tasksDone, total: s.tasksTotal } : null;
}

export type AgentState = "working" | "queued" | "done" | "failed" | "stopped";

export const AGENT_STATES: AgentState[] = ["working", "queued", "done", "failed", "stopped"];

export function agentStateOf(task: Task): AgentState {
  switch (task.status) {
    case "ready":
    case "running":
      return "working";
    case "pending":
      return "queued";
    case "done":
      return "done";
    case "failed":
    case "skipped":
      return "failed";
    default:
      return "stopped";
  }
}

/** Cuántas tareas del run activo hay en cada estado. */
export function countAgentStates(tasks: Task[]): Record<AgentState, number> {
  const counts: Record<AgentState, number> = { working: 0, queued: 0, done: 0, failed: 0, stopped: 0 };
  for (const t of tasks) counts[agentStateOf(t)] += 1;
  return counts;
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
