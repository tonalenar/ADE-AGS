import type { AgentUpdateInfo, AgentUpdateResult } from "./updatePolicy";

/** Lo que el flujo necesita del mundo, inyectado para poder probarlo sin procesos ni Tauri. */
export interface UpdateFlowDeps {
  /** Las pestañas abiertas, con su agente. */
  tabs: () => Array<{ id: string; agentId: string }>;
  ptyForTab: (tabId: string) => Promise<number | null>;
  ptyKill: (ptyId: number) => Promise<void>;
  /** Relanza el agente de una pestaña con `--resume` (ver `restartAgent` en el store de tabs). */
  restartAgent: (tabId: string) => void;
  /** Pregunta de nuevo, ahora, por el estado del agente (puede haber cambiado desde el aviso). */
  check: () => Promise<AgentUpdateInfo[]>;
  update: (agentId: string, terminalsReleased: boolean) => Promise<AgentUpdateResult>;
  sleep: (ms: number) => Promise<void>;
  /** Avisos de progreso (opcional). */
  onStage?: (stage: "closing" | "updating" | "reopening", count: number) => void;
}

export interface UpdateFlowOutcome {
  result: AgentUpdateResult;
  /** Cuántas pestañas se cerraron y se volvieron a abrir. */
  reopened: number;
}

/** Qué razones permiten seguir: ninguna, o solo que hay terminales abiertas (esas las cierra el flujo). */
const CAN_PROCEED = new Set<string | null>([null, "busy_terminal"]);

const KILL_WAIT_MS = 5000;
const KILL_POLL_MS = 100;

const failure = (agentId: string, error: string): AgentUpdateResult => ({
  agentId, ok: false, output: "", newVersion: null, error,
});

/**
 * "Actualizar" con un clic y sin pasos a mano: cierra las terminales de ese agente, lo
 * actualiza con su actualizador oficial y las vuelve a abrir retomando la conversación.
 *
 * Cuidados, en orden:
 * 1. Antes de tocar nada se pregunta de nuevo al backend. Si el agente está en una misión o
 *    un run en curso, o no se puede actualizar por otra razón, NO se cierra nada.
 * 2. Se cierran los procesos y se espera a que de verdad desaparezcan; si alguno sigue vivo
 *    no se actualiza (Windows no deja reemplazar un binario en uso).
 * 3. Pase lo que pase con la actualización, las pestañas que se cerraron se relanzan.
 */
export async function updateAgentRestarting(agentId: string, deps: UpdateFlowDeps): Promise<UpdateFlowOutcome> {
  const fresh = (await deps.check()).find((i) => i.agentId === agentId);
  if (!fresh) return { result: failure(agentId, "no_updater"), reopened: 0 };
  if (!CAN_PROCEED.has(fresh.reason ?? null)) {
    return { result: failure(agentId, String(fresh.reason ?? "failed")), reopened: 0 };
  }

  const tabs = deps.tabs().filter((t) => t.agentId === agentId);
  if (tabs.length > 0) deps.onStage?.("closing", tabs.length);

  const killed: string[] = [];
  for (const tab of tabs) {
    const pty = await deps.ptyForTab(tab.id);
    if (pty !== null) {
      await deps.ptyKill(pty);
      killed.push(tab.id);
    }
  }

  let result: AgentUpdateResult;
  try {
    // Hasta que no quede ninguno vivo no se actualiza.
    let waited = 0;
    let alive = killed;
    while (alive.length > 0 && waited < KILL_WAIT_MS) {
      await deps.sleep(KILL_POLL_MS);
      waited += KILL_POLL_MS;
      const still: string[] = [];
      for (const id of alive) if ((await deps.ptyForTab(id)) !== null) still.push(id);
      alive = still;
    }
    if (alive.length > 0) {
      result = failure(agentId, "busy_terminal");
    } else {
      deps.onStage?.("updating", tabs.length);
      result = await deps.update(agentId, true);
    }
  } catch (error) {
    result = { ...failure(agentId, "failed"), output: String(error) };
  } finally {
    if (killed.length > 0) deps.onStage?.("reopening", killed.length);
    for (const id of killed) deps.restartAgent(id);
  }
  return { result, reopened: killed.length };
}
