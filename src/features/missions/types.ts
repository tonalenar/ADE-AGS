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
  reasoningEffort?: string | null;
  /** Con `autoAccount = false`, `null` es la cuenta del sistema. */
  leadAccountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  /** Null for existing Missions that use the current routing policy. */
  squadId?: string | null;
  /** El run que la está cumpliendo. `null` mientras es borrador. */
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Por qué falló (solo `failed`); `null`/ausente = sin clasificar. Ver `failureClass.ts`. */
  failureClassification?: { category: "access" | "limit" | "model" | "crash" | "timeout"; actionKey: string } | null;
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
  reasoningEffort?: string | null;
  leadAccountId: string | null;
  autoAccount: boolean;
  complexity: Complexity | null;
  squadId?: string | null;
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
  /** Segundos con algún agente trabajando; `null` en misiones anteriores a esta medición. */
  activeSeconds: number | null;
}

export interface MissionDetail {
  mission: Mission;
  /** Sus runs, el más reciente primero. */
  runs: Run[];
  /** Las tareas del run activo, en el orden del plan. */
  tasks: Task[];
  facts: Fact[];
}

/** Ver `missions::review`. Un archivo de la entrega; `null` = binario. */
export interface FileChange {
  path: string;
  added: number | null;
  removed: number | null;
}

/** Lo que entregó una tarea aislada, y cómo va su revisión. */
export interface Delivery {
  taskId: string;
  title: string;
  functionalRole: string | null;
  status: string;
  branch: string;
  worktreeRemoved: boolean;
  commits: string[];
  files: FileChange[];
  /** Cambios sin commitear en su worktree: no se integran. */
  uncommitted: string[];
  review: "accepted" | "rejected" | "conflict" | null;
  /** En un conflicto, los archivos (uno por línea). */
  reviewNote: string | null;
}

export interface MissionReview {
  missionId: string;
  integrationBranch: string | null;
  /** Commits de la integración que el proyecto todavía no tiene. */
  pendingCommits: number;
  appliedAt: number | null;
  deliveries: Delivery[];
}

export type MergeOutcome =
  | { result: "Merged"; commit: string }
  | { result: "Conflict"; files: string[] };
