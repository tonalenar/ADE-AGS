/** Comandos das conversas do projeto (checkpoints, edição e busca). Ver `database/queries/sessions.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { SessionHistoryEntry } from "./types";

/** Mudanças numa conversa arquivada. Campo ausente = não mexe; `customTitle: null` = volta ao título automático. */
export interface SessionPatch {
  customTitle?: string | null;
  pinned?: boolean;
  hidden?: boolean;
}

export const updateHistoryEntry = (historyId: string, patch: SessionPatch) =>
  invoke<void>("db_update_session_history", { historyId, patch });

export const searchHistory = (workspaceId: string, query: string, limit = 50) =>
  invoke<SessionHistoryEntry[]>("db_search_session_history", { workspaceId, query, limit });
