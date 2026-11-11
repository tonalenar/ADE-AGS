import { useSyncExternalStore } from "react";

import type { ConversationCard } from "@/features/chat/chatModel";
import { normalizeProjectPath } from "@/features/chat/projectPath";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

/**
 * Como a barra agrupa as conversas em projetos (Configurações → Projetos), como o "agrupar por repositório" do T3 Code:
 * - `separate` (o padrão, como era antes): uma seção por pasta, e cada worktree do mesmo repositório é uma seção;
 * - `repository`: os checkouts do mesmo repositório (o principal e os worktrees) formam uma seção só, com o nome do repositório.
 *
 * É uma preferência deste aparelho (`localStorage`): não mexe em conversa, pasta nem banco, só em como a barra as junta.
 */
export type ProjectGroupingMode = "separate" | "repository";

export const PROJECT_GROUPING_MODES: readonly ProjectGroupingMode[] = ["separate", "repository"];
export const DEFAULT_PROJECT_GROUPING: ProjectGroupingMode = "separate";
export const PROJECT_GROUPING_KEY = "cc-project-grouping";

export function parseProjectGrouping(raw: string | null | undefined): ProjectGroupingMode {
  return raw === "repository" ? "repository" : DEFAULT_PROJECT_GROUPING;
}

/** Cada pasta aberta (normalizada) e o repositório a que pertence, para as pastas que estão num repositório git. */
export type RepoIndex = ReadonlyMap<string, { key: string; name: string }>;

export function buildRepoIndex(groups: readonly RepoGroup[]): RepoIndex {
  const index = new Map<string, { key: string; name: string }>();
  for (const group of groups) {
    if (!group.isRepo) continue;
    for (const ws of group.workspaces) index.set(normalizeProjectPath(ws.cwd), { key: group.key, name: group.name });
  }
  return index;
}

/**
 * No modo `repository`, a conversa de um checkout passa a ter o nome do repositório como projeto e a raiz dele como
 * identidade (`repoKey`); a pasta (`cwd`) não muda, porque abrir, mostrar o diff e criar conversa nova continuam
 * valendo para o checkout dela. Pasta fora de repositório e o modo `separate` devolvem os cartões como vieram. Pura.
 */
export function applyProjectGrouping(cards: ConversationCard[], mode: ProjectGroupingMode, index: RepoIndex): ConversationCard[] {
  if (mode !== "repository") return cards;
  return cards.map((card) => {
    const repo = index.get(normalizeProjectPath(card.cwd));
    return repo ? { ...card, project: repo.name, repoKey: repo.key } : card;
  });
}

const listeners = new Set<() => void>();

export function readProjectGrouping(): ProjectGroupingMode {
  try {
    return parseProjectGrouping(localStorage.getItem(PROJECT_GROUPING_KEY));
  } catch {
    return DEFAULT_PROJECT_GROUPING;
  }
}

export function saveProjectGrouping(mode: ProjectGroupingMode): void {
  try {
    localStorage.setItem(PROJECT_GROUPING_KEY, mode);
  } catch {
    // Sem armazenamento, a escolha vale só nesta sessão.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PROJECT_GROUPING_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useProjectGrouping(): ProjectGroupingMode {
  return useSyncExternalStore(subscribe, readProjectGrouping, readProjectGrouping);
}
