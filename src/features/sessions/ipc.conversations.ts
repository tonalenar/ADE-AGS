/** Comandos das conversas do projeto (checkpoints, edição e busca). Ver `database/queries/sessions.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { SessionHistoryEntry } from "./types";

export interface ArchivedMessageSearchHit {
  historyId: string;
  title: string;
  agentId: string;
  agentLabel: string;
  cwd: string;
  closedAt: number;
  turnIndex: number;
  sourceId: string | null;
  kind: "user" | "assistant";
  excerpt: string;
  partial: boolean;
  turnTruncated: boolean;
}

export interface ArchivedMessageTurn extends ArchivedMessageSearchHit {
  workspaceId: string;
  text: string;
}

/** Mudanças numa conversa arquivada. Campo ausente = não mexe; `customTitle: null` = volta ao título automático. */
export interface SessionPatch {
  customTitle?: string | null;
  pinned?: boolean;
  hidden?: boolean;
}

export const updateHistoryEntry = (historyId: string, patch: SessionPatch) =>
  invoke<void>("db_update_session_history", { historyId, patch });

/** Os ids de sessão que pertencem a terminais de missões deste workspace: não são conversas comuns do projeto. */
export const missionSessionIds = (workspaceId: string) =>
  invoke<string[]>("db_mission_session_ids", { workspaceId });

/** Recalcula os títulos fracos (caminho da pasta, "This session is being continued"…) a partir da sessão real. Devolve quantos mudaram. */
export const refreshSessionTitles = (workspaceId: string) =>
  invoke<number>("db_refresh_session_titles", { workspaceId });

export const searchHistory = (workspaceId: string, query: string, limit = 50) =>
  invoke<SessionHistoryEntry[]>("db_search_session_history", { workspaceId, query, limit });

/** Busca no índice de memória das TUI fechadas do workspace atual. */
export const searchArchivedSessionMessages = (workspaceId: string | null, query: string, limit = 20) =>
  invoke<ArchivedMessageSearchHit[]>("db_search_archived_session_messages", { workspaceId, query, limit });

/** Lê a fala do arquivo original só quando a pessoa abre um resultado da busca. */
export const getArchivedSessionTurn = (workspaceId: string, historyId: string, turnIndex: number, sourceId: string | null) =>
  invoke<ArchivedMessageTurn>("db_get_archived_session_turn", { workspaceId, historyId, turnIndex, sourceId });
