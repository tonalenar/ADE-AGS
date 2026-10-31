import { useMemo } from "react";

import { boardKeyOfTab, conversationOfKey, missionOfKey, useActiveBoardKey, useCanvasStore, useWorkMode } from "@/features/canvas/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";
import { teamGridIds } from "@/features/chat/team/teamModel";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath } from "@/features/tabs/viewTabs";

/** El prefijo del hueco de cada pane en la grade: `data-slot="grid:<tabId>"`. */
export const GRID_SLOT = "grid:";

/** Columnas de la grade para `count` panes: lo más cuadrada posible, más ancha que alta. Pura. */
export function gridColumns(count: number): number {
  return count <= 1 ? 1 : Math.ceil(Math.sqrt(count));
}

/**
 * Los panes de la grade de una misión o conversa de proyecto, o `null` si no corresponde (opción apagada, no es una
 * misión, hay menos de dos terminales, o la vista no es de abas). Pura.
 */
export function gridTabs(opts: { on: boolean; mission: string | null; team?: string[] | null; mode: string; tabIds: string[] }): string[] | null {
  if (!opts.on || opts.mode !== "tabs") return null;
  // Missão (ou conversa de projeto): os terminais do canvas dela. Senão, o time do chat da aba ativa.
  if (opts.mission) return opts.tabIds.length >= 2 ? opts.tabIds : null;
  return opts.team && opts.team.length >= 2 ? opts.team : null;
}

/** Un hueco medido de la grade (relativo al área del editor). */
export interface GridRect { left: number; top: number; width: number; height: number }

/** Un hueco sirve para ubicar una terminal solo si ya se midió y tiene tamaño real. Pura. */
export function usableSlot(rect: GridRect | null | undefined): rect is GridRect {
  return !!rect && rect.width > 0 && rect.height > 0;
}

/**
 * Dónde va cada terminal de la grade: `Map<tabId, rect>` solo con las que tienen hueco medido y
 * no vacío. Una sin hueco queda FUERA (oculta) en vez de ocupar toda el área —lo que taparía a
 * las demás— o de montarse en 0x0 (xterm sin `fit`). Pura.
 */
export function gridPlacements(ids: string[], slots: Record<string, GridRect>): Map<string, GridRect> {
  const out = new Map<string, GridRect>();
  for (const id of ids) {
    const rect = slots[GRID_SLOT + id];
    if (usableSlot(rect)) out.set(id, rect);
  }
  return out;
}

/** Los ids de las tabs a mostrar en grade en la misión activa, o `null` = vista de abas normal. */
export function useMissionGrid(): string[] | null {
  const key = useActiveBoardKey();
  const mode = useWorkMode();
  const on = useCanvasStore((s) => (key ? !!s.grids[key] : false));
  const boards = useCanvasStore((s) => s.boards);
  const tabs = useTabsStore((s) => s.tabs);
  const activeCwd = useTabsStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active ? comparablePath(active.cwd) : null;
  });
  // Con un archivo o navegador activo se ve ese, no la grade.
  const viewActive = useViewTabsStore((s) => {
    const view = s.views.find((v) => v.id === s.activeViewId);
    return !!view && comparablePath(view.cwd) === activeCwd;
  });
  const ids = useMemo(
    () => (key ? tabs.filter((t) => boardKeyOfTab(t, boards) === key).map((t) => t.id) : []),
    [key, tabs, boards],
  );
  const joined = ids.join("|");
  // O time do chat da aba ativa (só agentes abertos): a grade dele no lugar da de missão.
  const teams = useTeamIndex((s) => s.teams);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const agentTabs = useTabsStore((s) => s.tabs.filter((t) => t.agentId !== SHELL_AGENT_ID).map((t) => t.id).join("|"));
  const teamJoined = useMemo(() => teamGridIds(teams, activeTabId, agentTabs ? agentTabs.split("|") : [])?.join("|") ?? "", [teams, activeTabId, agentTabs]);
  return useMemo(
    () => (viewActive ? null : gridTabs({
      on, mission: missionOfKey(key) ?? conversationOfKey(key), team: teamJoined ? teamJoined.split("|") : null, mode, tabIds: joined ? joined.split("|") : [],
    })),
    [on, key, mode, joined, viewActive, teamJoined],
  );
}
