import type { Task, TaskStatus } from "@/features/runs/types";
import type { Tab } from "@/features/tabs/types";
import { SHELL_AGENT_ID } from "@/features/tabs/types";

/** Estados de tarea que cuentan como «activos» en la vista de flota: lo que aún no terminó. */
const ACTIVE_TASK: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["pending", "ready", "running"]);

export interface FleetTerminal {
  tabId: string;
  title: string;
  agentLabel: string;
  /** Escribe de corrido: la misma señal sostenida del indicador de pestañas y de «Ao vivo». */
  working: boolean;
}

export interface FleetGroup {
  missionId: string;
  title: string;
  tasks: Task[];
  terminals: FleetTerminal[];
}

interface FleetInput {
  missions: readonly { id: string; title: string; status: string }[];
  /** Tareas del run activo por misión: solo las de misiones cuyo detalle ya se cargó. */
  tasksByMission: Readonly<Record<string, readonly Task[]>>;
  tabs: readonly Pick<Tab, "id" | "title" | "agentId" | "agentLabel">[];
  /** tabId → misionId (`missionIndex`, la misma pertenencia del indicador y de «Ao vivo»). */
  missionIndex: Readonly<Record<string, string>>;
  sustainedTabIds: readonly string[];
}

/**
 * Todo lo que está activo en las misiones en curso, agrupado por misión. No inventa nada: una
 * tarea sale del run real, una terminal de la pertenencia real de la pestaña a la misión, y
 * una misión en curso sin tareas ni terminales abiertas sale vacía (se muestra tal cual).
 * Las misiones terminadas o en borrador no aparecen. Pura.
 */
export function fleetGroups(input: FleetInput): FleetGroup[] {
  const sustained = new Set(input.sustainedTabIds);
  return input.missions
    .filter((m) => m.status === "running")
    .map((m) => ({
      missionId: m.id,
      title: m.title,
      tasks: (input.tasksByMission[m.id] ?? []).filter((task) => ACTIVE_TASK.has(task.status)),
      terminals: input.tabs
        .filter((tab) => tab.agentId !== SHELL_AGENT_ID && input.missionIndex[tab.id] === m.id)
        .map((tab) => ({ tabId: tab.id, title: tab.title, agentLabel: tab.agentLabel, working: sustained.has(tab.id) })),
    }));
}
