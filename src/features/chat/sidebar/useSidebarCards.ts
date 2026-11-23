import { useEffect, useMemo, useRef } from "react";

import { useLocalAcpStore } from "@/features/agents/localAcpStore";
import { useTabsStore } from "@/features/tabs/store";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { chatProjects, conversationCards, type ChatProject, type ConversationCard } from "../chatModel";
import type { ThreadRow } from "../structured/ipc";
import { threadCards } from "../structured/model";
import { useStructured } from "../structured/store";
import { applyProjectGrouping, buildRepoIndex, useProjectGrouping, type ProjectGroupingMode } from "./projectGrouping";

function sameCard(a: ConversationCard, b: ConversationCard): boolean {
  return a.tabId === b.tabId
    && a.title === b.title
    && a.project === b.project
    && a.cwd === b.cwd
    && a.branch === b.branch
    && a.isWorktree === b.isWorktree
    && a.agentId === b.agentId
    && a.agentLabel === b.agentLabel
    && a.starting === b.starting
    && a.active === b.active
    && a.openedAt === b.openedAt
    && a.repoKey === b.repoKey;
}

/**
 * Monta os cartões da sidebar (conversas por protocolo + abas de agente), aplica o agrupamento por
 * projeto e reaproveita a referência anterior de cada cartão cujos campos não mudaram (para que
 * `memo(SessionRow)` só re-renderize a linha cuja conversa realmente mudou). Pura.
 */
export function buildSidebarCards(
  groups: RepoGroup[],
  threads: ThreadRow[],
  detected: readonly { id: string; label: string }[],
  localProviders: readonly { id: string; label: string }[],
  projectGrouping: ProjectGroupingMode,
  previous?: ReadonlyMap<string, ConversationCard>,
): ConversationCard[] {
  const labelOf = (id: string) => detected.find((a) => a.id === id)?.label ?? localProviders.find((a) => a.id === id)?.label ?? id;
  const all = [...threadCards(threads, groups, labelOf, null), ...conversationCards(groups)]
    .sort((a, b) => b.openedAt - a.openedAt);
  const grouped = applyProjectGrouping(all, projectGrouping, buildRepoIndex(groups));
  if (!previous || previous.size === 0) return grouped;
  return grouped.map((card) => {
    const prev = previous.get(card.tabId);
    return prev && sameCard(prev, card) ? prev : card;
  });
}

/** Pastas fechadas lembradas pelo painel que ainda não têm conversa aberta. Pura. */
export function buildClosedProjects(groups: RepoGroup[], cards: ConversationCard[]): ChatProject[] {
  const open = new Set(cards.map((c) => c.cwd));
  return groups
    .flatMap((g) => g.workspaces)
    .filter((w) => w.closed && !open.has(w.cwd))
    .map((w): ChatProject => ({ cwd: w.cwd, name: w.title, branch: w.branch }));
}

/**
 * Fonte única dos cartões, projetos e pastas fechadas da barra de conversas (compartilhada entre
 * `ChatShell` e `AppSessionsSidebar`, eliminando a duplicação e preservando identidade dos cartões).
 */
export function useSidebarCards(groups: RepoGroup[]): {
  cards: ConversationCard[];
  projects: ChatProject[];
  closed: ChatProject[];
} {
  const threads = useStructured((s) => s.threads);
  const detected = useTabsStore((s) => s.detectedAgents);
  const localProviders = useLocalAcpStore((s) => s.providers);
  const localProvidersLoaded = useLocalAcpStore((s) => s.loaded);
  const loadLocalProviders = useLocalAcpStore((s) => s.load);
  useEffect(() => {
    if (!localProvidersLoaded) void loadLocalProviders().catch(console.error);
  }, [localProvidersLoaded, loadLocalProviders]);
  const projectGrouping = useProjectGrouping();
  const prevCardsRef = useRef<Map<string, ConversationCard>>(new Map());

  const cards = useMemo(() => {
    const next = buildSidebarCards(groups, threads, detected, localProviders, projectGrouping, prevCardsRef.current);
    const nextMap = new Map<string, ConversationCard>();
    for (const card of next) nextMap.set(card.tabId, card);
    prevCardsRef.current = nextMap;
    return next;
  }, [groups, threads, detected, localProviders, projectGrouping]);

  const projects = useMemo(() => chatProjects(groups), [groups]);
  const closed = useMemo(() => buildClosedProjects(groups, cards), [groups, cards]);

  return { cards, projects, closed };
}
