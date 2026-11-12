import { invoke } from "@tauri-apps/api/core";

/** Espelho de `src-tauri/src/conversa/commands.rs` (`chat_task_stop`, `chat_task_output`). */

/** Para UMA tarefa em segundo plano (o `stop_task` do Claude Code); o fim chega pelo evento `task`. */
export const chatTaskStop = (threadId: string, taskId: string) => invoke<void>("chat_task_stop", { threadId, taskId });

export interface TaskOutput {
  output: string;
  total_bytes: number;
  truncated: boolean;
  /** O log para onde o comando mandou a saída, quando o arquivo da própria tarefa ficou vazio. */
  source?: string;
}

/** O fim da saída de um shell em segundo plano (os últimos 8 KiB; só leitura, sem turno de modelo). */
export const chatTaskOutput = (threadId: string, taskId: string) => invoke<TaskOutput>("chat_task_output", { threadId, taskId });
