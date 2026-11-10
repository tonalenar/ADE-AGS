import { invoke } from "@tauri-apps/api/core";

/** Restrições locais de provedores para o chat neste projeto. */
export interface ProjectChatAgentPolicy {
  cwd: string;
  disabledAgentIds: string[];
}

export const getProjectChatAgentPolicy = (cwd: string) =>
  invoke<ProjectChatAgentPolicy | null>("chat_project_agent_policy_get", { cwd });

export const assertProjectChatAgentEnabled = (cwd: string, agentId: string) =>
  invoke<void>("chat_project_agent_policy_check", { cwd, agentId });

export const saveProjectChatAgentPolicy = (cwd: string, disabledAgentIds: string[]) =>
  invoke<ProjectChatAgentPolicy>("chat_project_agent_policy_save", { cwd, disabledAgentIds });

export const clearProjectChatAgentPolicy = (cwd: string) =>
  invoke<void>("chat_project_agent_policy_clear", { cwd });
