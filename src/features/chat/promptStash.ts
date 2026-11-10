import { create } from "zustand";

import type { Quote } from "./quotes/quoteModel";
import {
  promptStashDelete,
  promptStashGet,
  promptStashList,
  promptStashSave,
} from "./promptStashesIpc";

/** Limite local, validado novamente no backend para evitar corridas entre janelas. */
export const MAX_PROMPT_STASHES = 10;

/** Resumo em memória; não inclui o texto, caminhos nem citações do rascunho. */
export interface PromptStashSummary {
  id: string;
  attachmentCount: number;
  quoteCount: number;
  savedAt: number;
}

/** Conteúdo completo, carregado do chaveiro apenas quando a pessoa restaura o rascunho. */
export interface PromptStash extends Omit<PromptStashSummary, "title" | "attachmentCount" | "quoteCount"> {
  text: string;
  attachmentPaths: string[];
  quotes: Pick<Quote, "text" | "comment" | "originItemId">[];
  quoteKey: string | null;
  cwd: string | null;
}

interface PromptStashState {
  items: PromptStashSummary[];
  loaded: boolean;
}

/** Só os resumos ficam em memória; os rascunhos salvos ficam no chaveiro do sistema. */
export const usePromptStash = create<PromptStashState>(() => ({ items: [], loaded: false }));

export async function loadPromptStashes(): Promise<PromptStashSummary[]> {
  const items = await promptStashList();
  usePromptStash.setState({ items, loaded: true });
  return items;
}

export async function savePromptStash(input: Omit<PromptStash, "id" | "savedAt">): Promise<PromptStashSummary> {
  const item = await promptStashSave(input);
  usePromptStash.setState((state) => ({
    items: [item, ...state.items.filter((existing) => existing.id !== item.id)].slice(0, MAX_PROMPT_STASHES),
    loaded: true,
  }));
  return item;
}

/** Carrega o texto sem consumir o rascunho salvo. */
export async function getPromptStash(id: string): Promise<PromptStash | null> {
  const item = await promptStashGet(id);
  if (!item) await loadPromptStashes();
  return item;
}

export async function removePromptStash(id: string): Promise<void> {
  await promptStashDelete(id);
  usePromptStash.setState((state) => ({ items: state.items.filter((stash) => stash.id !== id) }));
}
