/**
 * Lógica pura da árvore do harness (Fase 6): linhas, teclado, cursor/delta e consolidação dos eventos.
 * Fica fora do `.tsx` para testar sem DOM (`tests/harnessTreeModel.test.ts`).
 */
import type { HarnessExecutionEvent, HarnessExecutionGraph, HarnessExecutionNode } from "@/features/runs/types";

/** O teto da janela de eventos no front. Espelha `EVENT_WINDOW` de `runs/execution_log.rs`. */
export const EVENT_WINDOW = 250;

export interface TreeRow {
  node: HarnessExecutionNode;
  /** Nível ARIA, a partir de 1. A conversa raiz não é uma linha: o primeiro nível são os filhos dela. */
  level: number;
  parentId: string | null;
  childIds: string[];
}

/** As linhas da árvore, pai antes de filho. Nó cujo pai sumiu vira linha de primeiro nível, nunca se perde. */
export function buildTreeRows(nodes: HarnessExecutionNode[], rootThreadId: string): TreeRow[] {
  const rootNodeId = `thread:${rootThreadId}`;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, HarnessExecutionNode[]>();
  const tops: HarnessExecutionNode[] = [];
  for (const node of nodes) {
    if (node.id === rootNodeId) continue;
    if (!node.parentId || node.parentId === rootNodeId || !byId.has(node.parentId)) {
      tops.push(node);
      continue;
    }
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const visit = (node: HarnessExecutionNode, level: number, parentId: string | null) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const kids = children.get(node.id) ?? [];
    rows.push({ node, level, parentId, childIds: kids.map((kid) => kid.id) });
    for (const kid of kids) visit(kid, level + 1, node.id);
  };
  for (const node of tops) visit(node, 1, null);
  // Ciclo ou ordem estranha: o que sobrou entra como primeiro nível.
  for (const node of nodes) if (node.id !== rootNodeId) visit(node, 1, null);
  return rows;
}

/** Só abre sozinho o nó que tem filho bloqueado: é o que a pessoa precisa achar sem procurar. O resto começa recolhido. */
export function defaultExpanded(node: HarnessExecutionNode): boolean {
  return (node.blockedChildren ?? 0) > 0;
}

/** As linhas que aparecem: uma linha some quando algum ancestral está recolhido. */
export function visibleRows(rows: TreeRow[], expandedOf: (row: TreeRow) => boolean): TreeRow[] {
  const byId = new Map(rows.map((row) => [row.node.id, row]));
  const hidden = new Set<string>();
  const result: TreeRow[] = [];
  for (const row of rows) {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    const parentHides = parent ? hidden.has(parent.node.id) || !expandedOf(parent) : false;
    if (parentHides) {
      hidden.add(row.node.id);
      continue;
    }
    result.push(row);
  }
  return result;
}

export type TreeKeyResult = { focusId: string } | { toggle: { id: string; expanded: boolean } } | null;

/** O que uma tecla faz na linha em foco (padrão de árvore do WAI-ARIA). `null` = a tecla segue seu caminho. */
export function treeKey(
  key: string,
  visible: TreeRow[],
  focusedId: string,
  expandedOf: (row: TreeRow) => boolean,
): TreeKeyResult {
  const index = visible.findIndex((row) => row.node.id === focusedId);
  if (index < 0) return null;
  const row = visible[index];
  const expanded = expandedOf(row);
  switch (key) {
    case "ArrowDown":
      return index + 1 < visible.length ? { focusId: visible[index + 1].node.id } : null;
    case "ArrowUp":
      return index > 0 ? { focusId: visible[index - 1].node.id } : null;
    case "Home":
      return index > 0 ? { focusId: visible[0].node.id } : null;
    case "End":
      return index < visible.length - 1 ? { focusId: visible[visible.length - 1].node.id } : null;
    case "ArrowRight":
      if (!expanded) return { toggle: { id: row.node.id, expanded: true } };
      return row.childIds.length > 0 && visible[index + 1]?.parentId === row.node.id
        ? { focusId: visible[index + 1].node.id }
        : null;
    case "ArrowLeft":
      if (expanded) return { toggle: { id: row.node.id, expanded: false } };
      return row.parentId && visible.some((candidate) => candidate.node.id === row.parentId)
        ? { focusId: row.parentId }
        : null;
    case "Enter":
    case " ":
      return { toggle: { id: row.node.id, expanded: !expanded } };
    default:
      return null;
  }
}

/** O que o painel guarda da árvore: nós atuais, a janela de eventos e o cursor já aplicado. */
export interface GraphState {
  nodes: HarnessExecutionNode[];
  events: HarnessExecutionEvent[];
  cursor: number | null;
}

function sameNode(a: HarnessExecutionNode, b: HarnessExecutionNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Aplica uma resposta do backend. Sem `reset` ela é um delta: os eventos se somam (sem duplicar, em ordem, com
 * teto) e o cursor nunca volta. Com `reset`, ou sem o campo (backend antigo), troca tudo. Nó que não mudou
 * mantém a mesma referência, para a linha não ser redesenhada.
 */
export function applyGraphResponse(prev: GraphState | null, next: HarnessExecutionGraph): GraphState {
  const full = prev === null || next.reset !== false;
  const before = new Map((prev?.nodes ?? []).map((node) => [node.id, node]));
  const nodes = next.nodes.map((node) => {
    const old = before.get(node.id);
    return old && sameNode(old, node) ? old : node;
  });
  let events: HarnessExecutionEvent[];
  if (full) {
    events = [...next.events].sort((a, b) => a.sequence - b.sequence);
  } else {
    const bySequence = new Map((prev?.events ?? []).map((event) => [event.sequence, event]));
    for (const event of next.events) bySequence.set(event.sequence, event);
    events = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  }
  if (events.length > EVENT_WINDOW) events = events.slice(events.length - EVENT_WINDOW);
  const reported = typeof next.cursor === "number" ? next.cursor : (events[events.length - 1]?.sequence ?? null);
  const cursor = full || prev?.cursor == null || reported === null ? reported : Math.max(prev.cursor, reported);
  return { nodes, events, cursor };
}

/** O aviso `cc-harness-event` de uma conversa da linhagem, com cursor além do aplicado, pede uma leitura. */
export function shouldSync(change: unknown, known: ReadonlySet<string>, applied: number | null): boolean {
  if (!change || typeof change !== "object") return false;
  const { threadId, cursor } = change as { threadId?: unknown; cursor?: unknown };
  if (typeof threadId !== "string" || typeof cursor !== "number") return false;
  if (!known.has(threadId)) return false;
  return applied === null || cursor > applied;
}

export type EventPhase = "inProgress" | "persisted";

const OPENERS: Record<string, { group: string; closers: string[] }> = {
  "tool.started": { group: "tool", closers: ["tool.completed", "tool.failed", "tool.denied"] },
  "turn.started": { group: "turn", closers: ["turn.ended", "turn.interrupted", "turn.error"] },
  "fleet.attempt.started": { group: "attempt", closers: ["fleet.attempt.finished", "fleet.attempt.interrupted"] },
};

function phaseKey(group: string, event: HarnessExecutionEvent): string {
  return `${group}:${group === "attempt" ? (event.attemptId ?? event.entityId) : event.entityId}`;
}

/**
 * Todo evento da lista já foi persistido (tem sequência). "Em andamento" é o que abriu e ainda não tem o evento
 * que fecha: ferramenta sem fim, turno sem fim, tentativa sem fim.
 */
export function eventPhases(events: HarnessExecutionEvent[]): Map<number, EventPhase> {
  const closed = new Set<string>();
  for (const event of events) {
    for (const [, spec] of Object.entries(OPENERS)) {
      if (spec.closers.includes(event.kind)) closed.add(phaseKey(spec.group, event));
    }
  }
  const phases = new Map<number, EventPhase>();
  for (const event of events) {
    const spec = OPENERS[event.kind];
    const open = spec && event.entityId !== null && !closed.has(phaseKey(spec.group, event));
    phases.set(event.sequence, open ? "inProgress" : "persisted");
  }
  return phases;
}

/** Rotina: o que acontece o tempo todo e não pede nada da pessoa. Todo o resto é marco, falha, bloqueio ou fim. */
const ROUTINE_KINDS = new Set([
  "tool.started",
  "tool.completed",
  "message.user",
  "message.assistant",
  "fleet.tool.started",
  "turn.usage",
  "subagent.item",
]);

export type EventEntry =
  | { type: "milestone"; event: HarnessExecutionEvent }
  | {
      type: "digest";
      /** Quantos eventos de rotina o resumo cobre. Só números: nenhum texto de ferramenta ou mensagem. */
      count: number;
      tools: number;
      messages: number;
      fromSequence: number;
      toSequence: number;
    };

/** Marco útil fica sozinho; cada trecho seguido de eventos de rotina vira uma só linha de resumo. */
export function consolidateEvents(events: HarnessExecutionEvent[]): EventEntry[] {
  const entries: EventEntry[] = [];
  for (const event of events) {
    if (!ROUTINE_KINDS.has(event.kind)) {
      entries.push({ type: "milestone", event });
      continue;
    }
    const last = entries[entries.length - 1];
    const digest = last?.type === "digest"
      ? last
      : (entries[entries.push({ type: "digest", count: 0, tools: 0, messages: 0, fromSequence: event.sequence, toSequence: event.sequence }) - 1] as Extract<EventEntry, { type: "digest" }>);
    digest.count += 1;
    digest.toSequence = event.sequence;
    if (event.kind.startsWith("message.")) digest.messages += 1;
    else if (event.kind.includes("tool.")) digest.tools += 1;
  }
  return entries;
}

/** Estado que a linha mostra. `unknown` ganha de qualquer outro: o ADE não prova como o nó terminou. */
export function dataState(node: HarnessExecutionNode, override?: string): string {
  if (node.outcomeUnknown) return "unknown";
  const raw = override ?? node.executionStatus ?? node.status;
  switch (raw) {
    case "done":
    case "settled":
      return "completed";
    case "inProgress":
    case "working":
      return "running";
    case "ready":
      return "pending";
    default:
      return raw;
  }
}

const FINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted", "skipped", "handed_off", "unknown"]);

/** O estado final do nó, ou `null` enquanto ele ainda corre ou espera. */
export function finalState(node: HarnessExecutionNode, override?: string): string | null {
  const state = dataState(node, override);
  return FINAL_STATES.has(state) ? state : null;
}
