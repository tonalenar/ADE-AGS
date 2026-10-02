/**
 * El bus de eventos de la ADE, del lado de la UI (ver `src-tauri/src/bus.rs`).
 *
 * Todo lo que pasa en la flota y en las misiones llega por un único evento, `ade-event`,
 * numerado. Una vista que abre tarde se pone al día con `busSince` y después escucha.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export interface BusEvent {
  seq: number;
  /** Epoch en ms. */
  at: number;
  topic: string;
  taskId?: string;
  runId?: string;
  missionId?: string;
  data?: Record<string, unknown>;
}

export interface BusFilter {
  /** Prefijos: `task.` trae `task.changed` y `task.activity`. */
  topics?: string[];
  runId?: string;
  missionId?: string;
  taskId?: string;
}

export interface BusPage {
  events: BusEvent[];
  lastSeq: number;
  truncated: boolean;
}

export const busSince = (after: number, filter?: BusFilter, limit?: number) =>
  invoke<BusPage>("bus_since", { after, filter: filter ?? null, limit: limit ?? null });

/** Lo último que hizo cada tarea según `task.activity`: la herramienta o lo que dijo. */
export interface TaskActivity {
  kind: "started" | "tool" | "text" | "finished";
  label?: string;
  at: number;
}

function activityOf(event: BusEvent): TaskActivity | null {
  const data = event.data ?? {};
  const kind = data.kind as TaskActivity["kind"] | undefined;
  if (!kind) return null;
  const label = typeof data.label === "string" ? data.label : typeof data.text === "string" ? data.text : undefined;
  return { kind, label, at: event.at };
}

/**
 * La actividad más reciente de cada una de `taskIds`, en vivo: primero lo que el bus ya
 * tiene (por si la vista abrió en medio de la corrida) y después lo que va llegando.
 */
export function useTaskActivity(taskIds: string[]): Record<string, TaskActivity> {
  const [activity, setActivity] = useState<Record<string, TaskActivity>>({});
  const key = [...taskIds].sort().join("|");

  useEffect(() => {
    const wanted = new Set(key ? key.split("|") : []);
    if (wanted.size === 0) return;
    let stale = false;
    const apply = (events: BusEvent[]) => {
      if (stale) return;
      setActivity((prev) => {
        let next = prev;
        for (const e of events) {
          if (e.topic !== "task.activity" || !e.taskId || !wanted.has(e.taskId)) continue;
          const a = activityOf(e);
          if (!a) continue;
          if (next === prev) next = { ...prev };
          next[e.taskId] = a;
        }
        return next;
      });
    };
    busSince(0, { topics: ["task.activity"] }, 2000).then((page) => apply(page.events)).catch(() => {});
    const unlisten = listen<BusEvent>("ade-event", (e) => apply([e.payload]));
    return () => {
      stale = true;
      unlisten.then((off) => off());
    };
  }, [key]);

  return activity;
}
