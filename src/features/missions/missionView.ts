/**
 * Las piezas puras de la pantalla de misiones: qué acción ofrece cada estado, el avance,
 * el formulario. Sin React, para poder probarlas.
 */
import type { Complexity, PendingApproval, Task, TaskStatus } from "@/features/runs/types";

import type { Mission, MissionInput, MissionStatus } from "./types";

/**
 * Drafts start, running missions cancel, and failed missions can start a new attempt.
 */
export function missionAction(status: MissionStatus): "start" | "retry" | "cancel" | null {
  switch (status) {
    case "draft":
      return "start";
    case "running":
      return "cancel";
    case "failed":
      return "retry";
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
  executionMode: "automatic" | "specific" | "squad";
  squadId: string | null;
  agentId: string;
  model: string | null;
  reasoningEffort?: string | null;
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
    executionMode: "automatic",
    squadId: null,
    agentId: "claude-code",
    model: null,
    autoAccount: true,
    accountId: null,
    maxParallel: 2,
    budget: "",
  };
}

export function formFromMission(m: Mission): MissionForm {
  const fixed = m.leadAgentId !== null;
  return {
    title: m.title,
    objective: m.objective,
    cwd: m.cwd,
    mode: fixed ? (m.complexity ?? "fixed") : (m.complexity ?? "hard"),
    executionMode: m.squadId ? "squad" : fixed ? "specific" : "automatic",
    squadId: m.squadId ?? null,
    agentId: m.leadAgentId ?? "claude-code",
    model: m.leadModel,
    reasoningEffort: m.reasoningEffort ?? null,
    autoAccount: m.autoAccount,
    accountId: m.leadAccountId,
    maxParallel: m.maxParallel,
    budget: m.budgetUsd === null ? "" : String(m.budgetUsd),
  };
}

/** Keep the three execution modes mutually consistent in the editable draft form. */
export function switchExecutionMode(form: MissionForm, executionMode: MissionForm["executionMode"]): MissionForm {
  const stayingSpecific = executionMode === "specific" && form.executionMode === "specific";
  const stayingInSquad = executionMode === "squad" && form.executionMode === "squad";
  return {
    ...form,
    executionMode,
    reasoningEffort: stayingSpecific ? form.reasoningEffort : null,
    squadId: stayingInSquad ? form.squadId : null,
    mode: executionMode === "specific" ? "fixed" : form.mode === "fixed" ? "hard" : form.mode,
    autoAccount: stayingSpecific ? form.autoAccount : true,
    accountId: stayingSpecific ? form.accountId : null,
  };
}

/** Un presupuesto vacío o ilegible es "sin tope", no cero: cero no dejaría hacer nada. */
export function parseBudget(raw: string): number | null {
  // "1.000,50" (pt) e "1,000.50" (en): o último separador é o decimal, o outro agrupa milhares.
  let text = raw.trim();
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma > -1 && dot > -1) text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  else text = text.replace(",", ".");
  const n = Number(text);
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
  const squad = form.executionMode === "squad";
  const fixed = form.executionMode === "specific";
  return {
    title: form.title.trim(),
    objective: form.objective.trim(),
    cwd: form.cwd.trim(),
    maxParallel: form.maxParallel,
    budgetUsd: parseBudget(form.budget),
    // Con complejidad no se fija el agente: el ruteo decide cuál conviene.
    leadAgentId: squad ? null : fixed ? form.agentId : null,
    leadModel: squad ? null : fixed && form.mode === "fixed" ? form.model?.trim() || null : null,
    reasoningEffort: fixed && form.mode === "fixed" ? form.reasoningEffort ?? null : null,
    leadAccountId: squad || !fixed || form.autoAccount ? null : form.accountId,
    autoAccount: squad || !fixed ? true : form.autoAccount,
    complexity: squad || (fixed && form.mode === "fixed") ? null : form.mode === "fixed" ? "hard" : form.mode,
    squadId: squad ? form.squadId : null,
  };
}

/** Siglas que continuam em caixa alta quando um título em CAIXA ALTA é suavizado. */
const KEEP_UPPER = new Set(["CI", "PR", "IPC", "API", "UI", "UX", "QG", "TUI", "MCP", "CLI", "E2E", "SQL", "PTY", "ADE", "AGS", "XP", "OK", "IA", "QA", "CSS", "HTML", "JSON", "TTL"]);

/**
 * Vários títulos de missão vieram de briefings escritos em CAIXA ALTA ("CI: CARGO CHECK NO WINDOWS…"):
 * na lista, gritavam e ficavam ilegíveis. Isto só muda a EXIBIÇÃO — "Ci: cargo check no windows…" —
 * e deixa em paz o título que já está em caixa mista. O título guardado nunca é alterado.
 */
export function readableTitle(title: string): string {
  const letters = title.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 6) return title;
  const upper = letters.replace(/[^A-ZÀ-Ý]/g, "").length;
  if (upper / letters.length < 0.8) return title;
  const lowered = title.toLowerCase().replace(/[\p{L}\d]+/gu, (word) => (KEEP_UPPER.has(word.toUpperCase()) ? word.toUpperCase() : word));
  return lowered.replace(/^(\P{L}*)(\p{L})/u, (_, lead: string, first: string) => lead + first.toUpperCase());
}

/** Os dois últimos trechos de um caminho ("…/ADE-AGS" cabe onde "C:\Users\fulano\.x\ADE-AGS" não cabe). */
export function tailPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}
