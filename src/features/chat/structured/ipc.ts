import { invoke } from "@tauri-apps/api/core";

import type { ChatAccess } from "../chatModel";
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

export interface ThreadStatus {
  alive: boolean;
  working: boolean;
}

export const chatThreads = () => invoke<ThreadRow[]>("chat_threads");

export const chatThreadCreate = (input: {
  agentId: string; cwd: string; title: string; model: string | null; effort: string | null; access: ThreadAccess; accountId: string | null;
}) => invoke<ThreadRow>("chat_thread_create", input);

/** `images`: caminhos de imagens para o motor que as recebe em linha (o Claude); o caminho já está no texto. */
export const chatThreadSend = (threadId: string, text: string, images?: string[]) =>
  invoke<void>("chat_thread_send", { threadId, text, images: images && images.length > 0 ? images : null });
/** Troca o agente da conversa (só entre turnos): a mesma conversa, outro agente (`conversa/troca.rs`). */
export const chatThreadSwitchAgent = (threadId: string, agentId: string, model: string | null, effort: string | null, access: ThreadAccess, accountId: string | null) =>
  invoke<ThreadRow>("chat_thread_switch_agent", { threadId, agentId, model, effort, access, accountId });
export const chatThreadItems = (threadId: string) => invoke<TimelineItem[]>("chat_thread_items", { threadId });
export const chatThreadRequests = (threadId: string) => invoke<RequestRow[]>("chat_thread_requests", { threadId });
export const chatThreadStatus = (threadId: string) => invoke<ThreadStatus>("chat_thread_status", { threadId });
/** Reaplica a política do time e as regras da pessoa aos pedidos que esperam (o backend decide; ver `conversa::permission`). */
export const chatRequestsSweep = () => invoke<number>("chat_requests_sweep");
export const chatThreadInterrupt = (threadId: string) => invoke<void>("chat_thread_interrupt", { threadId });
export const chatRequestAnswer = (requestId: string, choice: string) => invoke<boolean>("chat_request_answer", { requestId, choice });
export const chatThreadRetune = (threadId: string, model: string | null, effort: string | null, access: ThreadAccess) =>
  invoke<ThreadRow>("chat_thread_retune", { threadId, model, effort, access });
export const chatThreadRename = (threadId: string, title: string) => invoke<void>("chat_thread_rename", { threadId, title });
export const chatThreadSettle = (threadId: string, settled: boolean) => invoke<void>("chat_thread_settle", { threadId, settled });
