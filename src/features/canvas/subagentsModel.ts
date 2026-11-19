import type { ThreadRow } from "@/features/chat/structured/ipc";
import type { ThreadLive } from "@/features/chat/structured/model";
import type { HarnessExecutionNode } from "@/features/runs/types";

import { THREAD_REF_PREFIX, type Board } from "./board";
import { facingSides, type Box } from "./geometry";

/** Prefixo de nós efêmeros de subagentes internos / tarefas delegadas / conversas filhas no canvas. */
export const EPHEMERAL_SUBAGENT_PREFIX = "subagent-ephemeral:";
/** Prefixo das cordas visuais (não persistidas) que penduram esses cartões no nó pai. */
export const EPHEMERAL_EDGE_PREFIX = "ephemeral-edge:";

export const SUBAGENT_CARD_SIZE = { w: 236, h: 72 };
export const SUBAGENT_GAP_X = 16;
export const SUBAGENT_OFFSET_Y = 44;

export const isEphemeralSubagentNodeId = (id: string): boolean => id.startsWith(EPHEMERAL_SUBAGENT_PREFIX);
export const isEphemeralEdgeId = (id: string): boolean => id.startsWith(EPHEMERAL_EDGE_PREFIX);

const SUBAGENT_TOOLS = new Set(["agent", "task", "subagent", "spawn_agent", "delegate_task"]);
const ACTIVE_HARNESS_STATUS = new Set(["pending", "ready", "running", "waiting"]);
const WAITING_HARNESS_STATUS = new Set(["pending", "ready", "waiting"]);

/** Ferramentas de terminal (TUI) que representam um subagente interno em execução. */
export function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOLS.has(name.trim().toLowerCase());
}

export type EphemeralSubagentKind = "internal" | "delegated" | "child";
export type EphemeralSubagentStatus = "working" | "waiting" | "idle";

export interface EphemeralSubagentCard {
  id: string;
  parentRef: string;
  kind: EphemeralSubagentKind;
  title: string;
  subtitle?: string;
  status: EphemeralSubagentStatus;
  /** Ref da conversa (`thread:<id>`) para abrir ao clicar, quando o cartão representa uma conversa real. */
  openRef?: string;
  box: Box;
}

export interface EphemeralLineageEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: "l" | "r" | "t" | "b";
  targetHandle: "l" | "r" | "t" | "b";
}

export interface EphemeralSubagentsResult {
  cards: EphemeralSubagentCard[];
  edges: EphemeralLineageEdge[];
}

export const EMPTY_EPHEMERAL_SUBAGENTS: EphemeralSubagentsResult = { cards: [], edges: [] };

export interface EphemeralSubagentsInput {
  board: Pick<Board, "nodes" | "threads" | "edges">;
  threads: Pick<ThreadRow, "id" | "title" | "agentId" | "state" | "parentRef">[];
  structuredLive: Record<string, Pick<ThreadLive, "phase" | "items" | "requests"> | undefined>;
  tabTurns: Record<string, { tools: { name: string; summary: string }[] } | undefined>;
  harnessTasks: Record<string, Pick<HarnessExecutionNode, "id" | "title" | "status" | "executionStatus" | "threadId" | "agentId" | "blocked">[] | undefined>;
}

interface PendingCard {
  id: string;
  parentRef: string;
  kind: EphemeralSubagentKind;
  title: string;
  subtitle?: string;
  status: EphemeralSubagentStatus;
  openRef?: string;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Projeta subagentes internos ativos, tarefas delegadas do harness e conversas filhas (`parentRef`)
 * como cartões compactos e cordas puramente visuais pendurados no nó pai.
 *
 * Nada daqui vai para `board.nodes`, `board.threads` nem `board.edges` em `canvas.json`: não cria
 * permissão extra em `ags peers`, não dispara espelho de time e se recolhe assim que a tarefa termina.
 */
export function buildEphemeralSubagents(input: EphemeralSubagentsInput): EphemeralSubagentsResult {
  const { board, threads, structuredLive, tabTurns, harnessTasks } = input;
  const parentBoxes = new Map<string, Box>();
  for (const [ref, box] of Object.entries(board.nodes)) parentBoxes.set(ref, box);
  for (const [ref, box] of Object.entries(board.threads)) parentBoxes.set(ref, box);
  if (parentBoxes.size === 0) return EMPTY_EPHEMERAL_SUBAGENTS;

  const persistedPairs = new Set(board.edges.map((e) => pairKey(e.a, e.b)));
  const edges: EphemeralLineageEdge[] = [];
  const cardsByParent = new Map<string, PendingCard[]>();
  const pushCard = (parentRef: string, card: PendingCard) => {
    const list = cardsByParent.get(parentRef);
    if (list) list.push(card);
    else cardsByParent.set(parentRef, [card]);
  };

  for (const parentRef of parentBoxes.keys()) {
    // 1. Subagentes internos em conversas por protocolo (ferramenta Task/Agent em execução).
    if (parentRef.startsWith(THREAD_REF_PREFIX)) {
      const threadId = parentRef.slice(THREAD_REF_PREFIX.length);
      const live = structuredLive[threadId];
      for (const item of live?.items ?? []) {
        if (item.kind !== "tool" || item.tool !== "task" || item.status !== "running") continue;
        pushCard(parentRef, {
          id: `${EPHEMERAL_SUBAGENT_PREFIX}task:${parentRef}:${item.id}`,
          parentRef,
          kind: "internal",
          title: (item.label || item.name || "").trim(),
          subtitle: item.name && item.label && item.name !== item.label ? item.name : undefined,
          status: "working",
        });
      }
    }

    // 2. Subagentes internos em terminais PTY (ferramenta Agent/Task ativa no turno atual).
    if (parentRef in board.nodes) {
      const tools = tabTurns[parentRef]?.tools ?? [];
      tools.forEach((tool, idx) => {
        if (!isSubagentToolName(tool.name)) return;
        pushCard(parentRef, {
          id: `${EPHEMERAL_SUBAGENT_PREFIX}pty:${parentRef}:${idx}:${tool.name}`,
          parentRef,
          kind: "internal",
          title: (tool.summary || tool.name).trim(),
          subtitle: tool.summary ? tool.name : undefined,
          status: "working",
        });
      });
    }

    // 3. Tarefas delegadas ativas do harness (fleetTask) enquanto não terminarem.
    for (const task of harnessTasks[parentRef] ?? []) {
      const eff = (task.executionStatus ?? task.status).toLowerCase();
      if (!ACTIVE_HARNESS_STATUS.has(eff)) continue;
      const openRef = task.threadId ? `${THREAD_REF_PREFIX}${task.threadId}` : undefined;
      if (openRef && openRef in board.threads) continue;
      pushCard(parentRef, {
        id: `${EPHEMERAL_SUBAGENT_PREFIX}fleet:${parentRef}:${task.id}`,
        parentRef,
        kind: "delegated",
        title: task.title.trim(),
        subtitle: task.agentId ?? undefined,
        status: task.blocked || WAITING_HARNESS_STATUS.has(eff) ? "waiting" : "working",
        openRef,
      });
    }
  }

  // 4. Conversas filhas ativas (`parentRef`): se já abertas como ThreadNode, ganham corda visual de linhagem;
  // caso contrário, aparecem como cartão compacto clicável pendurado no pai.
  const seenEdgePairs = new Set<string>();
  for (const row of threads) {
    if (row.state !== "active" || !row.parentRef) continue;
    const parentBox = parentBoxes.get(row.parentRef);
    if (!parentBox) continue;
    const childRef = `${THREAD_REF_PREFIX}${row.id}`;
    const pair = pairKey(row.parentRef, childRef);
    if (persistedPairs.has(pair)) continue;

    const childBox = board.threads[childRef];
    if (childBox) {
      if (seenEdgePairs.has(pair)) continue;
      seenEdgePairs.add(pair);
      const [sourceHandle, targetHandle] = facingSides(parentBox, childBox);
      edges.push({
        id: `${EPHEMERAL_EDGE_PREFIX}lineage:${row.parentRef}:${childRef}`,
        source: row.parentRef,
        target: childRef,
        sourceHandle,
        targetHandle,
      });
      continue;
    }

    const live = structuredLive[row.id];
    const hasPending = (live?.requests?.length ?? 0) > 0;
    const status: EphemeralSubagentStatus = hasPending ? "waiting" : live?.phase === "working" ? "working" : "idle";
    pushCard(row.parentRef, {
      id: `${EPHEMERAL_SUBAGENT_PREFIX}child:${childRef}`,
      parentRef: row.parentRef,
      kind: "child",
      title: row.title.trim(),
      subtitle: row.agentId,
      status,
      openRef: childRef,
    });
  }

  const cards: EphemeralSubagentCard[] = [];
  for (const [parentRef, list] of cardsByParent.entries()) {
    const parentBox = parentBoxes.get(parentRef);
    if (!parentBox || list.length === 0) continue;
    const totalW = list.length * SUBAGENT_CARD_SIZE.w + (list.length - 1) * SUBAGENT_GAP_X;
    const startX = Math.round(parentBox.x + (parentBox.w - totalW) / 2);
    const y = Math.round(parentBox.y + parentBox.h + SUBAGENT_OFFSET_Y);
    list.forEach((item, index) => {
      const box: Box = {
        x: startX + index * (SUBAGENT_CARD_SIZE.w + SUBAGENT_GAP_X),
        y,
        w: SUBAGENT_CARD_SIZE.w,
        h: SUBAGENT_CARD_SIZE.h,
      };
      cards.push({ ...item, box });
      edges.push({
        id: `${EPHEMERAL_EDGE_PREFIX}card:${item.id}`,
        source: parentRef,
        target: item.id,
        sourceHandle: "b",
        targetHandle: "t",
      });
    });
  }

  return { cards, edges };
}
