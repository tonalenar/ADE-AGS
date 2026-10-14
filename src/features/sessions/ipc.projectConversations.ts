/** Comandos das conversas-canvas de um projeto. Ver `database/queries/conversations.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { ConversationRow } from "./conversationModel";

/** Mudanças numa conversa. Campo ausente = não mexe; `customTitle: null` = volta ao título automático. */
export interface ConversationPatch {
  title?: string;
  customTitle?: string | null;
  pinned?: boolean;
  hidden?: boolean;
  state?: "active" | "saved";
  terminals?: unknown;
  /** Só marca a conversa como usada agora. */
  touch?: boolean;
}

export const createConversation = (workspaceId: string, projectKey: string, cwd: string, title?: string) =>
  invoke<ConversationRow>("db_conversation_create", { workspaceId, projectKey, cwd, title: title ?? null });

export const listConversations = (workspaceId: string, projectKey?: string) =>
  invoke<ConversationRow[]>("db_conversation_list", { workspaceId, projectKey: projectKey ?? null });

export const updateConversation = (id: string, patch: ConversationPatch) =>
  invoke<ConversationRow>("db_conversation_update", { id, patch });

export const deleteConversation = (id: string) => invoke<void>("db_conversation_delete", { id });

/** Marca UMA conversa do projeto como ativa (as outras viram salvas); `null` = nenhuma. */
export const setActiveConversation = (workspaceId: string, projectKey: string, id: string | null) =>
  invoke<void>("db_conversation_set_active", { workspaceId, projectKey, id });
