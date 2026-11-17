import { create } from "zustand";
import { createGeneration } from "@/shared/generation";
import * as ipc from "./ipc";
import type { SessionHistoryEntry, SessionSkillStatus } from "./types";

const historyGen = createGeneration();

interface SessionsState {
  history: SessionHistoryEntry[];
  loading: boolean;
  /** Por que a última carga falhou, ou `null`. */
  error: string | null;
  loadHistory: (workspaceId: string) => Promise<void>;
  /** Para cada skill archivada: si sigue instalada y, si no, de dónde bajarla. */
  checkSessionSkills: (historyId: string) => Promise<SessionSkillStatus[]>;
  /** Reattachea a la tab las que sí están; devuelve los nombres de las que faltan. */
  restoreSessionSkills: (historyId: string, workspaceId: string, tabId: string) => Promise<string[]>;
  /** Saca la sesión del historial. No borra el archivo de sesión del agente en disco. */
  deleteSession: (historyId: string, workspaceId: string) => Promise<void>;
  /** Markdown de la sesión (metadata + conversación), para previsualizar. */
  sessionMarkdown: (historyId: string) => Promise<string>;
  exportSession: (historyId: string, destPath: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  history: [],
  loading: false,
  error: null,

  loadHistory: async (workspaceId) => {
    const gen = historyGen.next();
    set({ loading: true, error: null });
    try {
      const rows = await ipc.listHistory(workspaceId);
      if (!historyGen.isCurrent(gen)) return;
      set({ history: rows });
    } catch (e) {
      if (!historyGen.isCurrent(gen)) return;
      // Sem isto a rejeição ficava sem tratar e o Histórico parecia simplesmente vazio.
      set({ error: String(e) });
    } finally {
      if (historyGen.isCurrent(gen)) set({ loading: false });
    }
  },

  checkSessionSkills: async (historyId) =>
    ipc.checkSessionSkills(historyId),

  restoreSessionSkills: async (historyId, workspaceId, tabId) =>
    ipc.restoreSessionSkills(historyId, workspaceId, tabId),

  deleteSession: async (historyId, workspaceId) => {
    await ipc.deleteHistoryEntry(historyId);
    await get().loadHistory(workspaceId);
  },

  sessionMarkdown: async (historyId) => ipc.sessionMarkdown(historyId),

  exportSession: async (historyId, destPath) =>
    ipc.exportSessionMarkdown(historyId, destPath),
}));
