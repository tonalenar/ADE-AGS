import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { THREAD_REF_PREFIX } from "./board";
import { listHarnessExecutionGraph } from "@/features/runs/ipc";
import type { HarnessExecutionNode } from "@/features/runs/types";

const ACTIVE_STATUS = new Set(["pending", "ready", "running", "waiting"]);
const EMPTY: Record<string, HarnessExecutionNode[]> = {};

function activeFleetTasks(nodes: HarnessExecutionNode[]): HarnessExecutionNode[] {
  return nodes.filter((node) => {
    if (node.kind !== "fleetTask") return false;
    const status = (node.executionStatus ?? node.status).toLowerCase();
    return ACTIVE_STATUS.has(status);
  });
}

/**
 * Lê as tarefas delegadas ativas (`fleetTask`) das conversas por protocolo visíveis no canvas.
 * Orientado a eventos (`cc-harness-event` / `cc-task-changed`), sem polling e totalmente ocioso
 * quando o canvas está escondido (`active = false`) ou sem conversas por protocolo.
 */
export function useBoardHarnessTasks(threadIds: string[], active: boolean): Record<string, HarnessExecutionNode[]> {
  const key = active ? [...threadIds].sort().join("|") : "";
  const [byRef, setByRef] = useState<Record<string, HarnessExecutionNode[]>>(EMPTY);

  useEffect(() => {
    if (!active || !key) {
      setByRef((prev) => (prev === EMPTY ? prev : EMPTY));
      return;
    }
    const ids = key.split("|");
    const knownThreads = new Set(ids);
    const knownTasks = new Set<string>();
    let alive = true;
    const inflight = new Set<string>();
    const pending = new Set<string>();

    const refresh = (threadId: string) => {
      if (inflight.has(threadId)) {
        pending.add(threadId);
        return;
      }
      inflight.add(threadId);
      void listHarnessExecutionGraph(threadId, null)
        .then((graph) => {
          if (!alive) return;
          const tasks = activeFleetTasks(graph.nodes);
          for (const task of tasks) knownTasks.add(task.id);
          const ref = `${THREAD_REF_PREFIX}${threadId}`;
          setByRef((prev) => {
            if (tasks.length === 0 && !(ref in prev)) return prev;
            const next = { ...prev };
            if (tasks.length === 0) delete next[ref];
            else next[ref] = tasks;
            return next;
          });
        })
        .catch(() => undefined)
        .finally(() => {
          inflight.delete(threadId);
          if (alive && pending.delete(threadId)) refresh(threadId);
        });
    };

    for (const id of ids) refresh(id);

    const listeners = [
      listen<{ threadId?: string }>("cc-harness-event", (event) => {
        const tid = event.payload?.threadId;
        if (tid && knownThreads.has(tid)) refresh(tid);
      }),
      listen<string>("cc-task-changed", (event) => {
        if (knownTasks.has(event.payload)) {
          for (const id of ids) refresh(id);
        }
      }),
    ];

    return () => {
      alive = false;
      listeners.forEach((p) => p.then((off) => off()).catch(() => undefined));
    };
  }, [active, key]);

  return byRef;
}
