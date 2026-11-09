import { create } from "zustand";
import { AlertaToast } from "@/shared/ui/alerts";
import { useTabsStore } from "@/features/tabs/store";
import { useSkillsStore } from "@/features/skills/store";
import { broadcastEvent, focusWindow } from "@/shared/ipc/window";

import * as ipc from "./ipc";
import type { WorkspaceSummary } from "./types";

interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  loading: boolean;
  loadWorkspaces: () => Promise<void>;
  /** Vacía el bucket "default" (cierra sus ventanas y borra lo guardado) y abre una
   *  ventana nueva en blanco ahí — "Nuevo workspace" del encabezado lateral. Si quería
   *  conservar lo anterior debía guardarlo antes con "Guardar workspace". */
  resetDefaultWorkspace: () => Promise<void>;
  /** Guarda bajo un nombre nuevo todas las ventanas abiertas que comparten el workspace
   *  actual de esta ventana (no necesariamente todas las ventanas abiertas en el proceso). */
  saveCurrentAsWorkspace: (name: string) => Promise<string>;
  /** Abre un workspace guardado; si closeCurrent, cierra primero todas las ventanas abiertas. */
  openWorkspace: (id: string, closeCurrent: boolean) => Promise<void>;
  /** Si el workspace ya tiene ventanas nativas vivas, las enfoca (en vez de abrir otro
   *  juego de ventanas duplicado) y devuelve `true` — el llamador no debe mostrar el
   *  diálogo de "cerrar actuales/mantener". Si devuelve `false`, el workspace no está
   *  abierto en ningún lado y el flujo normal (mostrar el diálogo) debe seguir. */
  focusIfOpen: (id: string) => Promise<boolean>;
  /** Foca o workspace aberto seguinte/anterior em ordem estável, sem abrir nem fechar janelas. */
  focusAdjacentOpenWorkspace: (delta: 1 | -1) => Promise<boolean>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  /** Falla (con mensaje legible) si el workspace tiene ventanas abiertas o es el de por defecto. */
  deleteWorkspace: (id: string) => Promise<void>;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  loading: false,

  loadWorkspaces: async () => {
    set({ loading: true });
    try {
      const rows = await ipc.listWorkspaces();
      set({ workspaces: rows });
    } finally {
      set({ loading: false });
    }
  },

  resetDefaultWorkspace: async () => {
    await ipc.resetDefaultWorkspace();
    await get().loadWorkspaces();
  },

  saveCurrentAsWorkspace: async (name) => {
    const sourceWorkspaceId = useTabsStore.getState().workspaceId;
    const ws = await ipc.saveWorkspace(name, sourceWorkspaceId);
    useTabsStore.getState().setWorkspaceId(ws.id);

    // `db_save_workspace` mueve en la DB TODAS las ventanas abiertas del workspace de
    // origen, no solo esta — pero el store en memoria de esas otras ventanas sigue
    // diciendo el id viejo. Quedaban creyendo que están en `default` mientras su fila ya
    // vive en el workspace nuevo: su autosave bumpeaba el `last_active` del workspace
    // equivocado (y con eso la app podía reabrir el workspace que no era), y "Nuevo
    // workspace" desde una de ellas apuntaba a un bucket que ya no las contiene.
    await broadcastEvent(
      "cc-workspace-reassigned",
      JSON.stringify({ from: sourceWorkspaceId, to: ws.id })
    ).catch(console.error);

    await get().loadWorkspaces();
    return ws.id;
  },

  openWorkspace: async (id, closeCurrent) => {
    await ipc.openWorkspace(id, closeCurrent);
    await get().loadWorkspaces();
    // Best-effort: no bloquea la apertura del workspace si el check falla.
    useSkillsStore.getState().checkHealth(id).then((issues) => {
      if (issues.length > 0) {
        AlertaToast("Skills", `${issues.length} skill symlink(s) need attention`, "warning", 6000);
      }
    }).catch(() => {});
  },

  focusIfOpen: async (id) => {
    const liveWindows = await ipc.openWindowsOf(id).catch(() => []);
    if (liveWindows.length === 0) return false;
    await focusWindow(liveWindows[0].label).catch(console.error);
    return true;
  },

  focusAdjacentOpenWorkspace: async (delta) => {
    const rows = await ipc.listWorkspaces();
    set({ workspaces: rows });

    // A lista vem do banco atualizado; as janelas vivas são consultadas em paralelo para
    // não confiar em contagens antigas de outra janela da ADE.
    const live = await Promise.all(rows.map(async (workspace) => {
      const windows = await ipc.openWindowsOf(workspace.id).catch(() => []);
      return {
        workspace,
        windows: [...windows].sort((a, b) => a.label.localeCompare(b.label)),
      };
    }));
    const open = live
      .filter((entry) => entry.windows.length > 0)
      .sort((a, b) => a.workspace.name.localeCompare(b.workspace.name) || a.workspace.id.localeCompare(b.workspace.id));
    if (open.length < 2) return false;

    const currentId = useTabsStore.getState().workspaceId;
    const currentIndex = open.findIndex((entry) => entry.workspace.id === currentId);
    const nextIndex = currentIndex < 0
      ? delta > 0 ? 0 : open.length - 1
      : (currentIndex + delta + open.length) % open.length;
    const target = open[nextIndex];
    if (!target) return false;
    await focusWindow(target.windows[0].label);
    return true;
  },

  renameWorkspace: async (id, name) => {
    await ipc.renameWorkspace(id, name);
    await get().loadWorkspaces();
  },

  deleteWorkspace: async (id) => {
    await ipc.deleteWorkspace(id);
    await get().loadWorkspaces();
  },
}));
