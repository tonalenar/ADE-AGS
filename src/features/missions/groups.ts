import { useMemo } from "react";

import { boardKeyOfTab, missionOfKey, useCanvasStore } from "@/features/canvas/store";
import type { Board } from "@/features/canvas/board";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";

/**
 * Qué pestañas son de qué misión: tabId → misionId, solo las que pertenecen a alguna. La
 * pertenencia vive en el canvas de cada misión (ver `boardKeyOfTab`). Pura.
 */
export function missionIndex(boards: Record<string, Board>, tabs: Pick<Tab, "id" | "cwd">[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tab of tabs) {
    const mission = missionOfKey(boardKeyOfTab(tab, boards));
    if (mission) out[tab.id] = mission;
  }
  return out;
}

/** Las pestañas de cada misión, en el orden en que están abiertas. Pura. */
export function tabsByMission(index: Record<string, string>, tabs: Pick<Tab, "id">[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const tab of tabs) {
    const mission = index[tab.id];
    if (mission) (out[mission] ??= []).push(tab.id);
  }
  return out;
}

/**
 * Las pestañas de misiones que ya terminaron (concluidas, canceladas o fallidas): cada una es
 * un agente vivo gastando memoria (Claude Code ~170 MB, Codex ~100 MB) y, al reabrir la app,
 * volvería a lanzarse con la sesión anterior. Pura.
 */
export function finishedMissionTabs(
  missions: { id: string; status: string }[],
  index: Record<string, string>,
  tabs: Pick<Tab, "id">[],
): string[] {
  const finished = new Set(missions.filter((m) => m.status === "done" || m.status === "cancelled" || m.status === "failed").map((m) => m.id));
  return tabs.filter((t) => finished.has(index[t.id])).map((t) => t.id);
}

/**
 * La pestaña a la que ir al abrir una misión: su orquestador (el de la corona) si está
 * abierto, si no la primera. `null` = no tiene ninguna pestaña abierta. Pura.
 */
export function entryTab(orchestrators: string[], missionTabs: string[]): string | null {
  return orchestrators.find((id) => missionTabs.includes(id)) ?? missionTabs[0] ?? null;
}

/** tabId → misionId, al día; solo cambia cuando cambia la pertenencia (no con cada arrastre de un nodo). */
export function useMissionIndex(): Record<string, string> {
  const tabs = useTabsStore((s) => s.tabs);
  const serialized = useCanvasStore((s) => JSON.stringify(missionIndex(s.boards, tabs)));
  return useMemo(() => JSON.parse(serialized) as Record<string, string>, [serialized]);
}

/** La misión de la pestaña activa, o `null` si es una suelta. Es el "grupo" que se está mirando. */
export function useActiveGroup(): string | null {
  const index = useMissionIndex();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  return activeTabId ? index[activeTabId] ?? null : null;
}

/** Va a una misión: activa su orquestador. `false` si no tiene pestañas abiertas. */
export function openMission(missionId: string): boolean {
  const { tabs, activateTab } = useTabsStore.getState();
  const boards = useCanvasStore.getState().boards;
  const index = missionIndex(boards, tabs);
  const mine = tabsByMission(index, tabs)[missionId] ?? [];
  const first = mine[0] ? tabs.find((t) => t.id === mine[0]) : undefined;
  const board = first ? boards[boardKeyOfTab(first, boards)] : undefined;
  const target = entryTab(board?.orchestrators ?? [], mine);
  if (!target) return false;
  activateTab(target);
  return true;
}

/** Va a las pestañas sueltas (sin misión): la última activa o la primera. */
export function openFree(): boolean {
  const { tabs, activeTabId, activateTab } = useTabsStore.getState();
  const index = missionIndex(useCanvasStore.getState().boards, tabs);
  const free = tabs.filter((t) => !index[t.id]);
  const target = free.find((t) => t.id === activeTabId) ?? free[0];
  if (!target) return false;
  activateTab(target.id);
  return true;
}

/**
 * Cerrar la pestaña de una misión con la "X" de arriba: pide confirmación mientras la misión
 * sigue en marcha (cerrar sus terminales mata a los agentes). Las terminadas, borradores o
 * sin estado se cierran directo. Pura.
 */
export function closeMissionNeedsConfirm(status: string | undefined): boolean {
  return status === "running";
}
