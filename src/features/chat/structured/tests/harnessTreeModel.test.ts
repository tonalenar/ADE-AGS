import { describe, expect, it } from "vitest";

import type { HarnessExecutionEvent, HarnessExecutionGraph, HarnessExecutionNode } from "@/features/runs/types";

import {
  EVENT_WINDOW,
  applyGraphResponse,
  buildTreeRows,
  consolidateEvents,
  defaultExpanded,
  eventPhases,
  shouldSync,
  treeKey,
  visibleRows,
} from "../harnessTreeModel";

const node = (partial: Pick<HarnessExecutionNode, "id" | "kind" | "status"> & Partial<HarnessExecutionNode>): HarnessExecutionNode => ({
  parentId: null,
  depth: 0,
  title: partial.id,
  threadId: "raiz",
  runId: null,
  agentId: "claude-code",
  model: null,
  planKey: null,
  attempt: null,
  createdAt: 1,
  startedAt: 1,
  endedAt: null,
  ...partial,
});

const event = (sequence: number, kind: string, extra: Partial<HarnessExecutionEvent> = {}): HarnessExecutionEvent => ({
  sequence,
  nodeId: `event:${sequence}`,
  parentNodeId: "turn:raiz:t1",
  threadId: "raiz",
  turnId: "t1",
  runId: null,
  taskId: null,
  attemptId: null,
  kind,
  entityId: null,
  payload: {},
  createdAt: sequence,
  ...extra,
});

const NODES = [
  node({ id: "thread:raiz", kind: "thread", status: "active" }),
  node({ id: "turn:raiz:t1", kind: "turn", status: "completed", parentId: "thread:raiz", blockedChildren: 0 }),
  node({ id: "run:r1", kind: "fleetRun", status: "running", parentId: "turn:raiz:t1" }),
  node({ id: "task:k1", kind: "fleetTask", status: "running", parentId: "run:r1" }),
  node({ id: "attempt:a1", kind: "fleetAttempt", status: "failed", parentId: "task:k1", attempt: 1 }),
  node({ id: "attempt:a2", kind: "fleetAttempt", status: "running", parentId: "task:k1", attempt: 2 }),
  node({ id: "turn:raiz:t2", kind: "turn", status: "completed", parentId: "thread:raiz" }),
];

describe("árvore do harness: linhas", () => {
  it("monta as linhas pai antes de filho, sem a conversa raiz, com o nível e os filhos", () => {
    const rows = buildTreeRows(NODES, "raiz");
    expect(rows.map((row) => row.node.id)).toEqual([
      "turn:raiz:t1", "run:r1", "task:k1", "attempt:a1", "attempt:a2", "turn:raiz:t2",
    ]);
    expect(rows.map((row) => row.level)).toEqual([1, 2, 3, 4, 4, 1]);
    expect(rows.find((row) => row.node.id === "task:k1")?.childIds).toEqual(["attempt:a1", "attempt:a2"]);
  });

  it("nó cujo pai sumiu não se perde: vira linha de primeiro nível", () => {
    const rows = buildTreeRows([node({ id: "task:solta", kind: "fleetTask", status: "done", parentId: "run:nao-existe" })], "raiz");
    expect(rows.map((row) => row.node.id)).toEqual(["task:solta"]);
    expect(rows[0].level).toBe(1);
  });

  it("só abre sozinho o nó que tem filho bloqueado; o resto começa recolhido", () => {
    expect(defaultExpanded(node({ id: "a", kind: "turn", status: "completed", blockedChildren: 2 }))).toBe(true);
    expect(defaultExpanded(node({ id: "a", kind: "turn", status: "completed", blockedChildren: 0 }))).toBe(false);
    expect(defaultExpanded(node({ id: "a", kind: "turn", status: "completed" }))).toBe(false);
  });

  it("recolher um nó esconde a subárvore inteira", () => {
    const rows = buildTreeRows(NODES, "raiz");
    const open = new Set(["turn:raiz:t1", "run:r1"]);
    expect(visibleRows(rows, (row) => open.has(row.node.id)).map((row) => row.node.id))
      .toEqual(["turn:raiz:t1", "run:r1", "task:k1", "turn:raiz:t2"]);
  });
});

describe("árvore do harness: teclado", () => {
  const rows = buildTreeRows(NODES, "raiz");
  const open = new Set(["turn:raiz:t1", "run:r1", "task:k1"]);
  const visible = visibleRows(rows, (row) => open.has(row.node.id));
  const expandedOf = (row: { node: { id: string } }) => open.has(row.node.id);

  it("setas verticais andam entre as linhas visíveis e param nas pontas", () => {
    expect(treeKey("ArrowDown", visible, "turn:raiz:t1", expandedOf)).toEqual({ focusId: "run:r1" });
    expect(treeKey("ArrowUp", visible, "run:r1", expandedOf)).toEqual({ focusId: "turn:raiz:t1" });
    expect(treeKey("ArrowUp", visible, "turn:raiz:t1", expandedOf)).toBeNull();
    expect(treeKey("ArrowDown", visible, "turn:raiz:t2", expandedOf)).toBeNull();
    expect(treeKey("Home", visible, "run:r1", expandedOf)).toEqual({ focusId: "turn:raiz:t1" });
    expect(treeKey("End", visible, "run:r1", expandedOf)).toEqual({ focusId: "turn:raiz:t2" });
  });

  it("seta para a direita abre o recolhido e, já aberto, desce ao primeiro filho", () => {
    expect(treeKey("ArrowRight", visible, "turn:raiz:t2", expandedOf)).toEqual({ toggle: { id: "turn:raiz:t2", expanded: true } });
    expect(treeKey("ArrowRight", visible, "run:r1", expandedOf)).toEqual({ focusId: "task:k1" });
  });

  it("seta para a esquerda recolhe o aberto e, já recolhido, sobe ao pai", () => {
    expect(treeKey("ArrowLeft", visible, "run:r1", expandedOf)).toEqual({ toggle: { id: "run:r1", expanded: false } });
    expect(treeKey("ArrowLeft", visible, "turn:raiz:t2", expandedOf)).toBeNull();
    const closed = visibleRows(rows, (row) => row.node.id === "turn:raiz:t1");
    expect(treeKey("ArrowLeft", closed, "run:r1", () => false)).toEqual({ focusId: "turn:raiz:t1" });
  });

  it("Enter e Espaço alternam o nó; outras teclas passam", () => {
    expect(treeKey("Enter", visible, "run:r1", expandedOf)).toEqual({ toggle: { id: "run:r1", expanded: false } });
    expect(treeKey(" ", visible, "turn:raiz:t2", expandedOf)).toEqual({ toggle: { id: "turn:raiz:t2", expanded: true } });
    expect(treeKey("a", visible, "run:r1", expandedOf)).toBeNull();
  });
});

describe("árvore do harness: cursor e delta", () => {
  const graph = (over: Partial<HarnessExecutionGraph>): HarnessExecutionGraph => ({
    rootThreadId: "raiz",
    nodes: NODES,
    events: [],
    cursor: 0,
    reset: true,
    ...over,
  });

  it("a primeira resposta, ou um reset, troca os eventos e fixa o cursor", () => {
    const first = applyGraphResponse(null, graph({ events: [event(1, "turn.started"), event(2, "tool.started")], cursor: 2 }));
    expect(first.cursor).toBe(2);
    expect(first.events.map((e) => e.sequence)).toEqual([1, 2]);
    const reset = applyGraphResponse(first, graph({ events: [event(9, "turn.ended")], cursor: 9, reset: true }));
    expect(reset.events.map((e) => e.sequence)).toEqual([9]);
    expect(reset.cursor).toBe(9);
  });

  it("o delta se soma ao que já havia, sem duplicar e em ordem", () => {
    const first = applyGraphResponse(null, graph({ events: [event(1, "turn.started"), event(2, "tool.started")], cursor: 2 }));
    const next = applyGraphResponse(first, graph({ events: [event(2, "tool.started"), event(4, "tool.completed"), event(3, "message.assistant")], cursor: 4, reset: false }));
    expect(next.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(next.cursor).toBe(4);
  });

  it("delta vazio mantém o cursor e nunca o faz voltar", () => {
    const first = applyGraphResponse(null, graph({ events: [event(5, "turn.started")], cursor: 5 }));
    const same = applyGraphResponse(first, graph({ events: [], cursor: 5, reset: false }));
    expect(same.cursor).toBe(5);
    const stale = applyGraphResponse(first, graph({ events: [], cursor: 3, reset: false }));
    expect(stale.cursor).toBe(5);
  });

  it("a janela de eventos tem teto: o mais antigo cede", () => {
    const many = Array.from({ length: EVENT_WINDOW }, (_, i) => event(i + 1, "tool.started"));
    const first = applyGraphResponse(null, graph({ events: many, cursor: EVENT_WINDOW }));
    const next = applyGraphResponse(first, graph({ events: [event(EVENT_WINDOW + 1, "tool.started")], cursor: EVENT_WINDOW + 1, reset: false }));
    expect(next.events).toHaveLength(EVENT_WINDOW);
    expect(next.events[0].sequence).toBe(2);
  });

  it("nó que não mudou mantém a mesma referência (a linha não é redesenhada)", () => {
    const first = applyGraphResponse(null, graph({ cursor: 1 }));
    const changed = NODES.map((n) => (n.id === "attempt:a2" ? { ...n, status: "done" } : { ...n }));
    const next = applyGraphResponse(first, graph({ nodes: changed, cursor: 2, reset: false }));
    expect(next.nodes.find((n) => n.id === "task:k1")).toBe(first.nodes.find((n) => n.id === "task:k1"));
    expect(next.nodes.find((n) => n.id === "attempt:a2")).not.toBe(first.nodes.find((n) => n.id === "attempt:a2"));
  });

  it("resposta sem cursor (backend antigo) é tratada como árvore inteira", () => {
    const old = { rootThreadId: "raiz", nodes: NODES, events: [event(1, "turn.started")] } as HarnessExecutionGraph;
    const state = applyGraphResponse(null, old);
    expect(state.cursor).toBe(1);
    expect(state.events).toHaveLength(1);
  });

  it("só pede delta quando o aviso é de uma conversa conhecida e o cursor passou do aplicado", () => {
    const known = new Set(["raiz", "filha"]);
    expect(shouldSync({ threadId: "filha", cursor: 8 }, known, 7)).toBe(true);
    expect(shouldSync({ threadId: "filha", cursor: 7 }, known, 7)).toBe(false);
    expect(shouldSync({ threadId: "filha", cursor: 3 }, known, 7)).toBe(false);
    expect(shouldSync({ threadId: "outra", cursor: 99 }, known, 7)).toBe(false);
    expect(shouldSync({ threadId: "raiz", cursor: 1 }, known, null)).toBe(true);
    expect(shouldSync("raiz", known, 7)).toBe(false);
  });
});

describe("em andamento versus persistido", () => {
  it("ferramenta iniciada sem fim está em andamento; a que terminou, falhou ou foi negada está registrada", () => {
    const phases = eventPhases([
      event(1, "tool.started", { entityId: "a" }),
      event(2, "tool.completed", { entityId: "a" }),
      event(3, "tool.started", { entityId: "b" }),
      event(4, "tool.started", { entityId: "c" }),
      event(5, "tool.failed", { entityId: "c" }),
      event(6, "turn.started", { entityId: "t1" }),
      event(7, "turn.started", { entityId: "t2" }),
      event(8, "turn.ended", { entityId: "t2" }),
    ]);
    expect(phases.get(1)).toBe("persisted");
    expect(phases.get(3)).toBe("inProgress");
    expect(phases.get(4)).toBe("persisted");
    expect(phases.get(6)).toBe("inProgress");
    expect(phases.get(7)).toBe("persisted");
    expect(phases.get(2)).toBe("persisted");
  });
});

describe("consolidação do progresso de baixo nível", () => {
  it("marco útil fica sozinho; o miolo de rotina vira uma única linha", () => {
    const events = [
      event(1, "turn.started"),
      ...Array.from({ length: 30 }, (_, i) => event(2 + i, i % 3 === 0 ? "message.assistant" : "tool.started", { entityId: `x${i}` })),
      event(40, "tool.failed", { entityId: "x1", payload: { label: "src/a.rs" } }),
      event(41, "permission.requested"),
      event(42, "turn.ended"),
    ];
    const entries = consolidateEvents(events);
    expect(entries.map((entry) => (entry.type === "milestone" ? entry.event.kind : "digest")))
      .toEqual(["turn.started", "digest", "tool.failed", "permission.requested", "turn.ended"]);
    const digest = entries[1];
    expect(digest.type === "digest" && digest.count).toBe(30);
    expect(digest.type === "digest" && digest.messages).toBe(10);
    expect(digest.type === "digest" && digest.tools).toBe(20);
  });

  it("falha, bloqueio e interrupção nunca entram no resumo de rotina", () => {
    const entries = consolidateEvents([
      event(1, "tool.denied"), event(2, "question.requested"), event(3, "turn.interrupted"), event(4, "fleet.attempt.interrupted"),
    ]);
    expect(entries.every((entry) => entry.type === "milestone")).toBe(true);
  });

  it("o resumo não carrega texto: só contagens e a faixa de sequência", () => {
    const [digest] = consolidateEvents([
      event(5, "tool.started", { payload: { label: "cat /etc/passwd" } }),
      event(6, "tool.completed", { payload: { label: "cat /etc/passwd" } }),
    ]);
    expect(JSON.stringify(digest)).not.toContain("passwd");
    expect(digest).toMatchObject({ type: "digest", count: 2, fromSequence: 5, toSequence: 6 });
  });

  it("sem eventos, sem entradas", () => {
    expect(consolidateEvents([])).toEqual([]);
  });
});
