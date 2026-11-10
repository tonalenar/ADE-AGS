import { invoke } from "@tauri-apps/api/core";

/** Os comandos das ações ficam no chaveiro do sistema, não no estado persistido do frontend. */
export const projectScriptCommandGet = (cwd: string, id: string) =>
  invoke<string | null>("chat_project_script_get", { cwd, id });

export const projectScriptCommandSave = (cwd: string, id: string, command: string) =>
  invoke<void>("chat_project_script_save", { cwd, id, command });

export const projectScriptCommandDelete = (cwd: string, id: string) =>
  invoke<void>("chat_project_script_delete", { cwd, id });

/** Inicia ação automática num processo one-shot, fora de qualquer PTY de conversa. */
export const projectScriptRunStart = (sourceCwd: string, executionCwd: string, id: string, runId: string) =>
  invoke<void>("chat_project_script_run_start", { sourceCwd, executionCwd, id, runId });

/** Encerra somente o processo contido nessa execução automática. */
export const projectScriptRunCancel = (runId: string) =>
  invoke<void>("chat_project_script_run_cancel", { runId });
