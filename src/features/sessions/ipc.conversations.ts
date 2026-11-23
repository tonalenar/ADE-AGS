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

/** Busca no índice de memória das TUI fechadas do workspace atual. */
export const searchArchivedSessionMessages = (workspaceId: string | null, query: string, limit = 20) =>
  invoke<ArchivedMessageSearchHit[]>("db_search_archived_session_messages", { workspaceId, query, limit });

/** Lê a fala do arquivo original só quando a pessoa abre um resultado da busca. */
export const getArchivedSessionTurn = (workspaceId: string, historyId: string, turnIndex: number, sourceId: string | null) =>
  invoke<ArchivedMessageTurn>("db_get_archived_session_turn", { workspaceId, historyId, turnIndex, sourceId });
