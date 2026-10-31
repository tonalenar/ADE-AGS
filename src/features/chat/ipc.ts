import { invoke } from "@tauri-apps/api/core";

import type { Timeline } from "./timeline/types";

/**
 * A conversa de uma aba como timeline, lida do transcript do agente (`ipc/commands/canal.rs`,
 * `conversation_timeline`). `null` = a aba não tem canal (agente sem transcript ou sessão sem
 * arquivo ainda).
 */
export const conversationTimeline = (tabId: string) => invoke<Timeline | null>("conversation_timeline", { tabId });

export interface WorkingDiff {
  root: string;
  text: string;
  truncated: boolean;
}

/** O `git diff HEAD` da pasta (`scm/commands.rs`, `scm_working_diff`). `null` = fora de um repo. */
export const scmWorkingDiff = (cwd: string) => invoke<WorkingDiff | null>("scm_working_diff", { cwd });

/** Um worktree novo para uma conversa (`conversa.rs`): onde o agente roda e a branch criada. */
export const chatNewWorktree = (cwd: string, title: string) => invoke<{ cwd: string; branch: string }>("chat_new_worktree", { cwd, title });

/**
 * O aviso do sistema de um pedido de permissão (`conversa/commands.rs`, `chat_permission_notify`):
 * o mesmo das missões, só com o app sem foco e com os avisos ligados. Devolve se apareceu.
 */
export const chatPermissionNotify = (title: string, body: string) => invoke<boolean>("chat_permission_notify", { title, body });
