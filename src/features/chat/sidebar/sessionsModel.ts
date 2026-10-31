/**
 * O modelo puro da barra de sessões (a mesma nos modos Chat, Abas e Canvas): as seções "Fixadas" e uma
 * por projeto, a ordem, a navegação por teclado e o título novo de um renomear. Sem React e sem store.
 */
import type { ConversationCard } from "../chatModel";

export interface SessionSection {
  /** `pinned` ou `project:<nome>` (é também o que se guarda para lembrar a seção recolhida). */
  id: string;
  kind: "pinned" | "project";
  label: string;
  items: ConversationCard[];
  collapsed: boolean;
}

export const PINNED_ID = "pinned";
export const projectSectionId = (project: string) => `project:${project}`;

export interface SectionOptions {
  query: string;
  folder: string | null;
  /** Os ids fixados, na ordem em que foram fixados. */
  pinned: string[];
  snoozed: string[];
  /** Os integrantes de time, que aparecem indentados sob o orquestrador e não na lista. */
  nested: Set<string>;
  /** Os ids das seções recolhidas. */
  collapsed: string[];
}

/**
 * As seções da barra: Fixadas primeiro (se houver), depois um projeto por seção, o que tem a conversa
 * mais recente em cima e, dentro dele, a mais recente em cima. A busca, o filtro de pasta, as adiadas e
 * os integrantes aninhados ficam de fora; seção vazia some. Pura.
 */
export function buildSections(cards: ConversationCard[], opts: SectionOptions): SessionSection[] {
  const q = opts.query.trim().toLowerCase();
  const shown = cards.filter((c) =>
    (!opts.folder || c.project === opts.folder)
    && (!q || `${c.title} ${c.project} ${c.agentLabel}`.toLowerCase().includes(q))
    && !opts.snoozed.includes(c.tabId)
    && !opts.nested.has(c.tabId));
  const byId = new Map(shown.map((c) => [c.tabId, c]));
  const pinnedCards = opts.pinned.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const pinnedSet = new Set(pinnedCards.map((c) => c.tabId));
  const sections: SessionSection[] = [];
  if (pinnedCards.length > 0) {
    sections.push({ id: PINNED_ID, kind: "pinned", label: "", items: pinnedCards, collapsed: opts.collapsed.includes(PINNED_ID) });
  }
  const byProject = new Map<string, ConversationCard[]>();
  for (const c of shown) {
    if (pinnedSet.has(c.tabId)) continue;
    byProject.set(c.project, [...(byProject.get(c.project) ?? []), c]);
  }
  const newest = (items: ConversationCard[]) => Math.max(...items.map((c) => c.openedAt));
  const projects = [...byProject.entries()]
    .map(([project, items]) => ({ project, items: [...items].sort((a, b) => b.openedAt - a.openedAt) }))
    .sort((a, b) => newest(b.items) - newest(a.items));
  for (const { project, items } of projects) {
    const id = projectSectionId(project);
    sections.push({ id, kind: "project", label: project, items, collapsed: opts.collapsed.includes(id) });
  }
  return sections;
}

/** Os ids que o teclado percorre: os das seções abertas, na ordem da tela. Pura. */
export function visibleIds(sections: SessionSection[]): string[] {
  return sections.filter((s) => !s.collapsed).flatMap((s) => s.items.map((c) => c.tabId));
}

/** Para onde vai o foco com ↓ (`1`) ou ↑ (`-1`): para nas pontas; sem foco, ↓ vai ao primeiro e ↑ ao último. Pura. */
export function stepFocus(ids: string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, at + dir))]!;
}

/** O título digitado num renomear: aparado, numa linha só, com teto; vazio = não renomeia (`null`). Pura. */
export function cleanTitle(raw: string): string | null {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 120) : null;
}

/** Põe no fim se não estava, tira se estava. Pura. */
export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Quantas conversas estão rodando e quantas ainda estão iniciando (o resumo que o painel de workspaces mostrava). Pura. */
export function countStates(cards: ConversationCard[]): { running: number; starting: number } {
  const starting = cards.filter((c) => c.starting).length;
  return { running: cards.length - starting, starting };
}

/** A inicial do avatar do rodapé: a primeira letra do nome, maiúscula; sem nome, `?`. Pura. */
export function initialOf(name: string | null | undefined): string {
  const first = (name ?? "").trim().charAt(0);
  return first ? first.toLocaleUpperCase() : "?";
}

/**
 * "Expandir/recolher todos": se todas as seções de projeto já estão recolhidas, abre tudo; senão recolhe
 * todas. Devolve a nova lista de recolhidas (a de Fixadas não entra: é da pessoa). Pura.
 */
export function toggleAllProjects(sections: SessionSection[], collapsed: string[]): string[] {
  const projects = sections.filter((s) => s.kind === "project").map((s) => s.id);
  const allCollapsed = projects.length > 0 && projects.every((id) => collapsed.includes(id));
  const rest = collapsed.filter((id) => !projects.includes(id));
  return allCollapsed ? rest : [...rest, ...projects];
}
