import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";

import { useMemoryPendingNotice } from "../memory/useMemoryPendingNotice";
import { ACTIVE_FLUSH_MS, ACTIVE_TICK_MS, accumulate, sampleWorking } from "./activeTime";
import { finishedMissionTabs, missionIndex, useMissionIndex } from "./groups";
import { useMissionsStore } from "./store";
import { recordSpan } from "./timings";

/** Lo que avisa el servidor al terminar un `peer ask` (ver `cc-peer-timing` en Rust). */
export interface PeerTimingEvent {
  from: string;
  to: string;
  toTabId: string;
  startedMs: number;
  endedMs: number;
  finished: boolean;
}

/**
 * Lo que las misiones hacen en segundo plano, con la barra lateral abierta o cerrada:
 *
 * - **cronómetro**: cada `peer ask` avisa cuánto esperó; acá se le pone la misión;
 * - **barrido**: una misión terminada cierra sus pestañas (y con ellas los procesos);
 * - **aviso de memoria**: cuando un agente sugiere una memoria, un aviso con la acción de abrirla.
 *
 * Vive aparte de la columna de Misiones a propósito: esa columna solo existe mientras la
 * barra está expandida, y con la barra recogida nadie escuchaba ni barría.
 */
export function useMissionWatcher(): void {
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const tabs = useTabsStore((s) => s.tabs);
  const missions = useMissionsStore((s) => s.missions);
  const load = useMissionsStore((s) => s.load);
  const index = useMissionIndex();

  // Aviso cuando un agente sugiere una memoria; también con la barra lateral recogida.
  useMemoryPendingNotice(workspaceId);

  // Las misiones del workspace, al día.
  useEffect(() => {
    if (!workspaceId) return;
    load(workspaceId).catch(() => undefined);
    const off = listen<string>("cc-mission-changed", () => load(workspaceId).catch(() => undefined));
    return () => {
      off.then((fn) => fn());
    };
  }, [workspaceId, load]);

  // Cronómetro de los `peer ask`.
  useEffect(() => {
    const off = listen<PeerTimingEvent>("cc-peer-timing", (e) => {
      const { tabs: openTabs } = useTabsStore.getState();
      const mission = missionIndex(useCanvasStore.getState().boards, openTabs)[e.payload.toTabId];
      if (!mission) return;
      recordSpan(mission, {
        kind: "peer_ask",
        actor: e.payload.from,
        target: e.payload.to,
        startedMs: e.payload.startedMs,
        endedMs: e.payload.endedMs,
        detail: e.payload.finished ? "" : "timeout",
      });
    });
    return () => {
      off.then((fn) => fn());
    };
  }, []);

  // Tiempo activo: solo avanza mientras algún agente de la misión trabaja de verdad.
  const live = useRef({ index, missions });
  live.current = { index, missions };
  useEffect(() => {
    let pending = new Map<string, number>();
    let ticks = 0;
    const flush = () => {
      for (const [id, ms] of pending) invoke("mission_active_add", { missionId: id, ms }).catch(() => undefined);
      pending = new Map();
    };
    const timer = setInterval(() => {
      const { index: tabToMission, missions: all } = live.current;
      const running = new Set(all.filter((m) => m.status === "running").map((m) => m.id));
      pending = accumulate(pending, sampleWorking(tabToMission, running), ACTIVE_TICK_MS);
      ticks += 1;
      if (ticks * ACTIVE_TICK_MS >= ACTIVE_FLUSH_MS) {
        ticks = 0;
        flush();
      }
    }, ACTIVE_TICK_MS);
    return () => {
      clearInterval(timer);
      flush();
    };
  }, []);

  // Barrido de las pestañas de misiones terminadas.
  useEffect(() => {
    if (missions.length === 0) return;
    const { closeTab } = useTabsStore.getState();
    finishedMissionTabs(missions, index, tabs).forEach((id) => closeTab(id));
  }, [missions, index, tabs]);
}
