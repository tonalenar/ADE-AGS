import { invoke } from "@tauri-apps/api/core";

import type { ChatAccess } from "./chatModel";

/**
 * Os padrões de conversa por projeto, no banco (`src-tauri/src/project_chat_defaults.rs`): o agente e o modelo, o modelo
 * reserva, o workspace e a permissão. Campo `null` herda do aparelho.
 */
export interface ModelChoiceDto {
  agentId: string;
  /** `null` = o padrão do agente. */
  model: string | null;
}

export interface ProjectChatDefaultsDto {
  cwd: string;
  primary: ModelChoiceDto | null;
  /** Entra no lugar do principal quando o principal está sem limite de uso. */
  fallback: ModelChoiceDto | null;
  workspace: "local" | "worktree" | null;
  access: ChatAccess | null;
}

/** O que valeria numa conversa nova agora, com o reserva já aplicado se o principal está sem limite. */
export interface EffectiveSelectionDto {
  agentId: string;
  model: string | null;
  usedFallback: boolean;
  /** Até quando o principal fica sem limite (segundos), se está. */
  limitedUntil: number | null;
}

export interface EffectiveDefaultsDto {
  defaults: ProjectChatDefaultsDto | null;
  selection: EffectiveSelectionDto | null;
}

export const chatProjectDefaultsList = () => invoke<ProjectChatDefaultsDto[]>("chat_project_defaults_list");

export const chatProjectDefaultsGet = (cwd: string) => invoke<ProjectChatDefaultsDto | null>("chat_project_defaults_get", { cwd });

export const chatProjectDefaultsEffective = (cwd: string, accountId: string | null) =>
  invoke<EffectiveDefaultsDto>("chat_project_defaults_effective", { cwd, accountId });

export const chatProjectDefaultsSave = (defaults: ProjectChatDefaultsDto) =>
  invoke<ProjectChatDefaultsDto | null>("chat_project_defaults_save", { defaults });

export const chatProjectDefaultsClear = (cwd: string) => invoke<void>("chat_project_defaults_clear", { cwd });
