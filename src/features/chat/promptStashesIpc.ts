import { invoke } from "@tauri-apps/api/core";

import type { PromptStash, PromptStashSummary } from "./promptStash";

export const promptStashList = () =>
  invoke<PromptStashSummary[]>("chat_prompt_stashes_list");

export const promptStashSave = (input: Omit<PromptStash, "id" | "savedAt">) =>
  invoke<PromptStashSummary>("chat_prompt_stash_save", { input });

export const promptStashGet = (id: string) =>
  invoke<PromptStash | null>("chat_prompt_stash_get", { id });

export const promptStashDelete = (id: string) =>
  invoke<void>("chat_prompt_stash_delete", { id });
