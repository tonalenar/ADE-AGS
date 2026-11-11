import { invoke } from "@tauri-apps/api/core";

import type { ChatAccess, ProviderRuntimeConfig } from "../chatModel";
import type { TimelineItem } from "../timeline/types";

/**
 * O acesso de uma conversa por protocolo: os modos do chat e, no Claude Code, o Plano (que lá é um
 * modo de permissão, `--permission-mode plan`).
 */
export type ThreadAccess = ChatAccess | "plan";

/** Espelho de `src-tauri/src/conversa/store.rs`. */
export interface ThreadRow {
  id: string;
  agentId: string;
  cwd: string;
  title: string;
  model: string | null;
  effort: string | null;
  access: ThreadAccess;
  accountId: string | null;
  /** O ai-memory na abertura do processo: `on` ou `off:<código>`; `null` = o processo ainda não abriu. */
  memory?: string | null;
  parentRef?: string | null;
  parentTurnId?: string | null;
  isSideChat?: boolean;
  /** Como a pergunta lateral nasceu: `native` (cópia da sessão da origem) ou `excerpt` (recorte do histórico). */
  forkMode?: "native" | "excerpt" | null;
  /** Só em `excerpt`: o código do motivo (`conversa::fork::Reason`). */
  forkReason?: string | null;
  state: "active" | "settled";
  createdAt: number;
  updatedAt: number;
}

export interface QuestionOption {
  id: string;
  question: string;
  options: string[];
}

export interface RequestRow {
  id: string;
  threadId: string;
  kind: "command" | "fileChange" | "question";
  itemId: string | null;
  title: string;
  detail: string;
  /** Pergunta: as perguntas. Aprovação do Claude: a ferramenta (`{tool}`). Aprovação do Codex: `[]`. */
  options: QuestionOption[] | { tool?: string } | null;
  state: "pending" | "answered" | "expired";
  createdAt: number;
}

export interface MessageSearchHit {
  threadId: string;
  title: string;
  agentId: string;
  cwd: string;
  itemId: string;
  kind: "user" | "assistant";
  excerpt: string;
}

export interface ThreadStatus {
  alive: boolean;
  working: boolean;
}

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  updatedAt: number;
}

export const chatThreads = () => invoke<ThreadRow[]>("chat_threads");

export const chatThreadCreate = (input: {
  agentId: string; cwd: string; workspaceId?: string | null; title: string; model: string | null; effort: string | null; access: ThreadAccess; accountId: string | null; parentRef?: string | null;
}) => invoke<ThreadRow>("chat_thread_create", { ...input, parentRef: input.parentRef ?? null });
/** O desfecho do fork da pergunta lateral (`chat_side_chat_fork`). */
export interface SideChatForkOutcome {
  mode: "native" | "excerpt";
  reason: string | null;
}
/** Faz a pergunta lateral nascer como cópia da conversa de origem, ou diz que cai no recorte e por quê. */
export const chatSideChatFork = (threadId: string) => invoke<SideChatForkOutcome>("chat_side_chat_fork", { threadId });
export const chatSideChatDelete = (threadId: string) => invoke<void>("chat_side_chat_delete", { threadId });

/** `images`: caminhos de imagens para o motor que as recebe em linha (o Claude); o caminho já está no texto. */
export const chatThreadSend = (threadId: string, text: string, images?: string[]) =>
  invoke<void>("chat_thread_send", { threadId, text, images: images && images.length > 0 ? images : null });

/** O recibo de um envio com `clientRequestId` (contrato do harness §11.7). */
export interface SendReceipt {
  requestId: string;
  /** `accepted`, `submitting`, `retryable` ou `unknown`. */
  deliveryState: string;
  /** `true` numa repetição: o recibo veio do banco e nada foi enviado. */
  replayed: boolean;
  /** `true` só quando esta chamada enviou a mensagem ao provider. */
  sent: boolean;
  note?: string;
}

/** Como `chatThreadSend`, mas idempotente: repetir o mesmo `clientRequestId` devolve o recibo sem reenviar. */
export const chatThreadSendOnce = (threadId: string, text: string, clientRequestId: string, images?: string[]) =>
  invoke<SendReceipt>("chat_thread_send", { threadId, text, images: images && images.length > 0 ? images : null, clientRequestId });
/** Troca o agente da conversa (só entre turnos): a mesma conversa, outro agente (`conversa/troca.rs`). */
export const chatThreadSwitchAgent = (threadId: string, agentId: string, model: string | null, effort: string | null, access: ThreadAccess, accountId: string | null) =>
  invoke<ThreadRow>("chat_thread_switch_agent", { threadId, agentId, model, effort, access, accountId });
export const chatThreadItems = (threadId: string) => invoke<TimelineItem[]>("chat_thread_items", { threadId });
export const chatThreadSearch = (query: string, limit = 30) => invoke<MessageSearchHit[]>("chat_thread_search", { query, limit });
export const chatThreadRequests = (threadId: string) => invoke<RequestRow[]>("chat_thread_requests", { threadId });
export const chatThreadStatus = (threadId: string) => invoke<ThreadStatus>("chat_thread_status", { threadId });
export const chatThreadProviderConfig = (threadId: string) => invoke<ProviderRuntimeConfig | null>("chat_thread_provider_config", { threadId });
export const chatThreadGoalGet = (threadId: string) => invoke<ThreadGoal | null>("chat_thread_goal_get", { threadId });
export const chatThreadGoalAction = (threadId: string, action: "show" | "set" | "pause" | "resume" | "clear", objective?: string) =>
  invoke<ThreadGoal | null>("chat_thread_goal_action", { threadId, action, objective: objective ?? null });
export const chatThreadCompactContext = (threadId: string, instructions?: string) => invoke<void>("chat_thread_compact_context", { threadId, instructions: instructions ?? null });
export const chatThreadAutoCompactOnReturn = (threadId: string) => invoke<boolean>("chat_thread_auto_compact_on_return", { threadId });
/** Reinicia a sessão do provedor e preserva a timeline da ADE. */
export const chatThreadClearContext = (threadId: string) => invoke<void>("chat_thread_clear_context", { threadId });
/** Reaplica a política do time e as regras da pessoa aos pedidos que esperam (o backend decide; ver `conversa::permission`). */
export const chatRequestsSweep = () => invoke<number>("chat_requests_sweep");
export const chatThreadInterrupt = (threadId: string) => invoke<void>("chat_thread_interrupt", { threadId });
export const chatRequestAnswer = (requestId: string, choice: string) => invoke<boolean>("chat_request_answer", { requestId, choice });
export const chatThreadRetune = (threadId: string, model: string | null, effort: string | null, access: ThreadAccess) =>
  invoke<ThreadRow>("chat_thread_retune", { threadId, model, effort, access });
/** Troca a conta de uma conversa aberta (entre turnos; o agente recebe um resumo na próxima mensagem). */
export const chatAccountSet = (threadId: string, accountId: string | null) => invoke<void>("chat_account_set", { threadId, accountId });
export const chatThreadRename = (threadId: string, title: string) => invoke<void>("chat_thread_rename", { threadId, title });
export const chatThreadSettle = (threadId: string, settled: boolean) => invoke<void>("chat_thread_settle", { threadId, settled });
