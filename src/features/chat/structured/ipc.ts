import { invoke } from "@tauri-apps/api/core";

import type { ChatAccess } from "../chatModel";
import type { TimelineItem } from "../timeline/types";

/** Espelho de `src-tauri/src/conversa/store.rs`. */
export interface ThreadRow {
  id: string;
  agentId: string;
  cwd: string;
  title: string;
  model: string | null;
  effort: string | null;
  access: ChatAccess;
  accountId: string | null;
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
  options: QuestionOption[] | null;
  state: "pending" | "answered" | "expired";
  createdAt: number;
}

export interface ThreadStatus {
  alive: boolean;
  working: boolean;
}

export const chatThreads = () => invoke<ThreadRow[]>("chat_threads");

export const chatThreadCreate = (input: {
  agentId: string; cwd: string; title: string; model: string | null; effort: string | null; access: ChatAccess; accountId: string | null;
}) => invoke<ThreadRow>("chat_thread_create", input);

export const chatThreadSend = (threadId: string, text: string) => invoke<void>("chat_thread_send", { threadId, text });
export const chatThreadItems = (threadId: string) => invoke<TimelineItem[]>("chat_thread_items", { threadId });
export const chatThreadRequests = (threadId: string) => invoke<RequestRow[]>("chat_thread_requests", { threadId });
export const chatThreadStatus = (threadId: string) => invoke<ThreadStatus>("chat_thread_status", { threadId });
export const chatThreadInterrupt = (threadId: string) => invoke<void>("chat_thread_interrupt", { threadId });
export const chatRequestAnswer = (requestId: string, choice: string) => invoke<boolean>("chat_request_answer", { requestId, choice });
export const chatThreadRetune = (threadId: string, model: string | null, effort: string | null, access: ChatAccess) =>
  invoke<ThreadRow>("chat_thread_retune", { threadId, model, effort, access });
export const chatThreadRename = (threadId: string, title: string) => invoke<void>("chat_thread_rename", { threadId, title });
export const chatThreadSettle = (threadId: string, settled: boolean) => invoke<void>("chat_thread_settle", { threadId, settled });
