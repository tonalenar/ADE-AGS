import type { Complexity, Fact, Run, Task, TaskStatus } from "@/features/runs/types";

/**
 * Solo los estados que el ejecutor sostiene hoy. No hay `paused` (no existe pausa real) ni
 * `planning`: lo que está haciendo el lead se lee de sus tareas.
 */
export type MissionStatus = "draft" | "running" | "done" | "failed" | "cancelled";

/** Lo que el usuario quiere lograr, por encima de los intentos (runs) de lograrlo. */
export interface Mission {
  id: string;
  workspaceId: string;
  title: string;
  objective: string;
  cwd: string;
  status: MissionStatus;
  maxParallel: number;
  budgetUsd: number | null;
  /** `null` = lo elige el ruteo por complejidad. */
  leadAgentId: string | null;
  leadModel: string | null;
  /** Con `autoAccount = false`, `null` es la cuenta del sistema. */
  leadAccountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  /** El run que la está cumpliendo. `null` mientras es borrador. */
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** Lo que se manda al crear o editar. */
export interface MissionInput {
  title: string;
  objective: string;
  cwd: string;
  maxParallel: number | null;
  budgetUsd: number | null;
  leadAgentId: string | null;
  leadModel: string | null;
  leadAccountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
}

/** Una fila de la lista, con el avance de su run activo. */
export interface MissionSummary extends Mission {
  spentUsd: number;
  /** Las tareas del run activo sin contar al lead. */
  workersTotal: number;
  workersDone: number;
  /** A quién le tocó el lead (el ruteo puede haber elegido). */
  leadAgent: string | null;
  /** El estado de la tarea del lead, aparte del avance. */
  leadStatus: TaskStatus | null;
}

export interface MissionDetail {
  mission: Mission;
  /** Sus runs, el más reciente primero. */
  runs: Run[];
  /** Las tareas del run activo, en el orden del plan. */
  tasks: Task[];
  facts: Fact[];
}
