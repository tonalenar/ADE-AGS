import { invoke } from "@tauri-apps/api/core";

import { getSetting, setSetting } from "@/shared/ipc/settings";

/**
 * O pool de contas no chat: quando a conta de uma conversa esgota o limite, ela segue em outra conta do MESMO
 * pool. O interruptor é global, de decisão da pessoa, e o padrão é desligado (ver `conversa::pool`).
 */
export type ChatPoolMode = "off" | "ask" | "auto";

export const CHAT_POOL_MODES: ChatPoolMode[] = ["off", "ask", "auto"];
export const CHAT_POOL_MODE_KEY = "chat.pool.mode";

/** Valor guardado → modo. Qualquer coisa desconhecida é «desligado». Pura. */
export function parseChatPoolMode(raw: string | null | undefined): ChatPoolMode {
  return raw === "ask" || raw === "auto" ? raw : "off";
}

export const loadChatPoolMode = async (): Promise<ChatPoolMode> => parseChatPoolMode(await getSetting(CHAT_POOL_MODE_KEY).catch(() => null));
export const saveChatPoolMode = (mode: ChatPoolMode) => setSetting(CHAT_POOL_MODE_KEY, mode);

/** O que espera a resposta da pessoa numa conversa («Continuar na conta B?», «Voltar à A?»). */
export interface ChatPoolPending {
  kind: "switch" | "return" | "join";
  to: string | null;
  toLabel: string;
  request: string | null;
}

export const chatPoolPending = (threadId: string) => invoke<ChatPoolPending | null>("chat_pool_pending", { threadId });
export const chatPoolAccept = (threadId: string) => invoke<void>("chat_pool_accept", { threadId });
export const chatPoolDismiss = (threadId: string) => invoke<void>("chat_pool_dismiss", { threadId });

/** O pool da conversa (se houver) e a conta de origem depois de uma troca. */
export interface ChatPoolState {
  poolName: string | null;
  originLabel: string | null;
}

export const chatPoolState = (threadId: string) => invoke<ChatPoolState>("chat_pool_state", { threadId });
