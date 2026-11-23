import { boardKey, boardKeyOfTab, missionOfKey, useCanvasStore } from "@/features/canvas/store";
import type { Board } from "@/features/canvas/board";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
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
 * La pestaña a la que ir al abrir una misión: su orquestador (el de la corona) si está
 * abierto, si no la primera. `null` = no tiene ninguna pestaña abierta. Pura.
 */
export function entryTab(orchestrators: string[], missionTabs: string[]): string | null {
  return orchestrators.find((id) => missionTabs.includes(id)) ?? missionTabs[0] ?? null;
}

const EMPTY_MISSION_INDEX: Record<string, string> = Object.freeze({});
let cachedBoards: Record<string, Board> | null = null;
let cachedTabs: readonly Pick<Tab, "id" | "cwd">[] | null = null;
let cachedTeams: unknown = null;
let cachedTeamsLoaded: boolean | null = null;
let cachedWindowPrefix: string | null = null;
let cachedIndex: Record<string, string> = EMPTY_MISSION_INDEX;

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function cachedMissionIndex(
  boards: Record<string, Board>,
  tabs: Pick<Tab, "id" | "cwd">[],
  teams: unknown,
  teamsLoaded: boolean,
  windowPrefix: string,
): Record<string, string> {
  if (
    boards === cachedBoards
    && tabs === cachedTabs
    && teams === cachedTeams
    && teamsLoaded === cachedTeamsLoaded
    && windowPrefix === cachedWindowPrefix
  ) {
    return cachedIndex;
  }
  const next = missionIndex(boards, tabs);
  const stable = sameStringRecord(cachedIndex, next) ? cachedIndex : next;
  cachedBoards = boards;
  cachedTabs = tabs;
  cachedTeams = teams;
  cachedTeamsLoaded = teamsLoaded;
  cachedWindowPrefix = windowPrefix;
  cachedIndex = stable;
  return stable;
}

/** tabId → misionId, al día; solo cambia cuando cambia la pertenencia (no con cada arrastre de un nodo). */
export function useMissionIndex(): Record<string, string> {
  const tabs = useTabsStore((s) => s.tabs);
  const teams = useTeamIndex((s) => s.teams);
  const teamsLoaded = useTeamIndex((s) => s.loaded);
  const windowPrefix = boardKey("");
  return useCanvasStore((s) => cachedMissionIndex(s.boards, tabs, teams, teamsLoaded, windowPrefix));
}

/** La misión de la pestaña activa, o `null` si es una suelta. Es el "grupo" que se está mirando. */
export function useActiveGroup(): string | null {
  const index = useMissionIndex();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  return activeTabId ? index[activeTabId] ?? null : null;
}

/** Uma missão `failed` fica visível na lateral por este tempo: dá para iniciá-la de novo (segundos). */
export const RECENT_FAILED_S = 24 * 3600;

/**
 * ¿La misión va a "archivadas" en la lista lateral? Terminadas y canceladas, siempre. Una FALLIDA
 * reciente no: se puede retomar con un clic (antes un cierre de la app la mandaba a archivadas
 * junto con 60 antiguas y parecía haber desaparecido). Pura.
 */
export function isArchivedMission(m: { status: string; updatedAt: number }, nowSec = Date.now() / 1000): boolean {
  if (m.status === "done" || m.status === "done_without_delivery" || m.status === "cancelled") return true;
  return m.status === "failed" && nowSec - m.updatedAt >= RECENT_FAILED_S;
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
