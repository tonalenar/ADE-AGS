import { invoke } from "@tauri-apps/api/core";

import { getSetting, setSetting } from "@/shared/ipc/settings";

/**
 * Política global de troca de conta em pools (vale para conversas e tarefas em segundo plano).
 * Sem valor salvo, o padrão é `"ask"` ("Perguntar"). Ver `accounts/pools.rs` e `conversa/pool.rs`.
 */
export type ChatPoolMode = "off" | "ask" | "auto";

export const CHAT_POOL_MODES: ChatPoolMode[] = ["off", "ask", "auto"];
export const CHAT_POOL_MODE_KEY = "chat.pool.mode";

/** Valor guardado → modo. Ausente/vazio = `"ask"` ("Perguntar"); desconhecido falha fechado em `"off"`. Pura. */
export function parseChatPoolMode(raw: string | null | undefined): ChatPoolMode {
  if (raw === null || raw === undefined || raw.trim() === "") return "ask";
  const value = raw.trim();
  if (value === "off" || value === "ask" || value === "auto") return value;
  return "off";
}

export const loadChatPoolMode = async (): Promise<ChatPoolMode> => parseChatPoolMode(await getSetting(CHAT_POOL_MODE_KEY).catch(() => null));
export const saveChatPoolMode = (mode: ChatPoolMode) => setSetting(CHAT_POOL_MODE_KEY, mode);

/** O que espera a resposta da pessoa numa conversa («Continuar na conta B?», «Voltar à A?»). */
export interface ChatPoolPending {
  kind: "switch" | "return" | "join" | "fallback";
  to: string | null;
  toLabel: string;
  request: string | null;
  /** Só em `fallback`: o agente e o modelo reserva do projeto. */
  agentId?: string | null;
  model?: string | null;
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
