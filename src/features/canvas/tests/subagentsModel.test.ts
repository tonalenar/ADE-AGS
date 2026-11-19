import { describe, expect, it } from "vitest";

import { emptyBoard, type Board } from "../board";
import {
  buildEphemeralSubagents,
  EMPTY_EPHEMERAL_SUBAGENTS,
  isEphemeralEdgeId,
  isEphemeralSubagentNodeId,
  isSubagentToolName,
  SUBAGENT_CARD_SIZE,
  SUBAGENT_GAP_X,
  SUBAGENT_OFFSET_Y,
  type EphemeralSubagentsInput,
} from "../subagentsModel";

const baseInput = (over: Partial<EphemeralSubagentsInput> = {}): EphemeralSubagentsInput => ({
  board: emptyBoard(),
  threads: [],
  structuredLive: {},
  tabTurns: {},
  harnessTasks: {},
  ...over,
});

describe("subagentsModel", () => {
  it("reconhece nomes conhecidos de ferramenta de subagente em TUI", () => {
    expect(isSubagentToolName("Agent")).toBe(true);
    expect(isSubagentToolName("Task")).toBe(true);
    expect(isSubagentToolName("spawn_agent")).toBe(true);
    expect(isSubagentToolName("delegate_task")).toBe(true);
    expect(isSubagentToolName("Bash")).toBe(false);
    expect(isSubagentToolName("Read")).toBe(false);
  });

  it("retorna vazio quando não há nós de agente nem conversas no board", () => {
    expect(buildEphemeralSubagents(baseInput())).toBe(EMPTY_EPHEMERAL_SUBAGENTS);
  });

  it("cria cartão compacto e corda efêmera para ferramenta Task em andamento numa conversa por protocolo e some ao concluir", () => {
    const board: Board = {
      ...emptyBoard(),
      threads: { "thread:p1": { x: 100, y: 200, w: 600, h: 400 } },
    };

    const running = buildEphemeralSubagents(baseInput({
      board,
      structuredLive: {
        p1: {
          phase: "working",
          requests: [],
          items: [
            { kind: "tool", id: "tool-1", tool: "task", name: "Explore", label: "Mapeando rotas", status: "running" },
            { kind: "tool", id: "tool-2", tool: "command", name: "Bash", label: "ls", status: "running" },
          ],
        },
      },
    }));

    expect(running.cards).toHaveLength(1);
    expect(running.cards[0]).toMatchObject({
      parentRef: "thread:p1",
      kind: "internal",
      title: "Mapeando rotas",
      subtitle: "Explore",
      status: "working",
      box: {
        x: 100 + Math.round((600 - SUBAGENT_CARD_SIZE.w) / 2),
        y: 200 + 400 + SUBAGENT_OFFSET_Y,
        w: SUBAGENT_CARD_SIZE.w,
        h: SUBAGENT_CARD_SIZE.h,
      },
    });
    expect(isEphemeralSubagentNodeId(running.cards[0]!.id)).toBe(true);
    expect(running.edges).toHaveLength(1);
    expect(isEphemeralEdgeId(running.edges[0]!.id)).toBe(true);
    expect(running.edges[0]).toMatchObject({ source: "thread:p1", target: running.cards[0]!.id, sourceHandle: "b", targetHandle: "t" });

    // Quando o subagente termina, o cartão e a corda se recolhem sozinhos.
    const finished = buildEphemeralSubagents(baseInput({
      board,
      structuredLive: {
        p1: {
          phase: "idle",
          requests: [],
          items: [
            { kind: "tool", id: "tool-1", tool: "task", name: "Explore", label: "Mapeando rotas", status: "done" },
          ],
        },
      },
    }));
    expect(finished.cards).toEqual([]);
    expect(finished.edges).toEqual([]);
  });

  it("cria cartão efêmero para subagente interno rodando em terminal PTY (Agent/Task)", () => {
    const board: Board = {
      ...emptyBoard(),
      nodes: { tab1: { x: 0, y: 0, w: 500, h: 300 } },
    };

    const res = buildEphemeralSubagents(baseInput({
      board,
      tabTurns: {
        tab1: {
          tools: [
            { name: "Read", summary: "src/app.tsx" },
            { name: "Agent", summary: "Revisar segurança" },
          ],
        },
      },
    }));

    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]).toMatchObject({
      parentRef: "tab1",
      kind: "internal",
      title: "Revisar segurança",
      subtitle: "Agent",
      status: "working",
    });
    expect(res.edges).toHaveLength(1);
    expect(res.edges[0]!.source).toBe("tab1");
  });

  it("projeta tarefas delegadas (fleetTask) ativas e ignora concluídas ou já abertas como ThreadNode", () => {
    const board: Board = {
      ...emptyBoard(),
      threads: {
        "thread:p1": { x: 0, y: 0, w: 600, h: 400 },
        "thread:open-child": { x: 700, y: 0, w: 600, h: 400 },
      },
    };

    const res = buildEphemeralSubagents(baseInput({
      board,
      harnessTasks: {
        "thread:p1": [
          { id: "ft-1", title: "Escrever testes", status: "running", executionStatus: "running", threadId: "t-hidden", agentId: "codex", blocked: null },
          { id: "ft-2", title: "Aguardando aprovação", status: "waiting", executionStatus: "waiting", threadId: null, agentId: "claude-code", blocked: { kind: "approval", count: 1 } },
          { id: "ft-3", title: "Já concluída", status: "done", executionStatus: "completed", threadId: null, agentId: "codex", blocked: null },
          { id: "ft-4", title: "Já aberta", status: "running", executionStatus: "running", threadId: "open-child", agentId: "codex", blocked: null },
        ],
      },
    }));

    expect(res.cards.map((c) => ({ title: c.title, kind: c.kind, status: c.status, openRef: c.openRef }))).toEqual([
      { title: "Escrever testes", kind: "delegated", status: "working", openRef: "thread:t-hidden" },
      { title: "Aguardando aprovação", kind: "delegated", status: "waiting", openRef: undefined },
    ]);
    // Dois cartões no mesmo pai ficam lado a lado sem sobreposição.
    expect(res.cards[1]!.box.x).toBe(res.cards[0]!.box.x + SUBAGENT_CARD_SIZE.w + SUBAGENT_GAP_X);
    expect(res.cards[1]!.box.y).toBe(res.cards[0]!.box.y);
  });

  it("conecta conversa filha ativa: cartão clicável quando fechada, corda de linhagem quando já aberta e nada se concluída ou já ligada por corda persistida", () => {
    const board: Board = {
      ...emptyBoard(),
      threads: {
        "thread:parent": { x: 0, y: 0, w: 600, h: 400 },
        "thread:open-child": { x: 750, y: 0, w: 600, h: 400 },
        "thread:persisted-child": { x: 0, y: 600, w: 600, h: 400 },
      },
      edges: [{ id: "e-persisted", a: "thread:parent", b: "thread:persisted-child" }],
    };

    const res = buildEphemeralSubagents(baseInput({
      board,
      threads: [
        { id: "closed-child", title: "Filha fechada", agentId: "codex", state: "active", parentRef: "thread:parent" },
        { id: "open-child", title: "Filha aberta", agentId: "codex", state: "active", parentRef: "thread:parent" },
        { id: "persisted-child", title: "Filha já ligada", agentId: "codex", state: "active", parentRef: "thread:parent" },
        { id: "done-child", title: "Filha encerrada", agentId: "codex", state: "settled", parentRef: "thread:parent" },
      ],
      structuredLive: {
        "closed-child": { phase: "working", items: [], requests: [] },
      },
    }));

    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]).toMatchObject({
      parentRef: "thread:parent",
      kind: "child",
      title: "Filha fechada",
      subtitle: "codex",
      status: "working",
      openRef: "thread:closed-child",
    });

    // Duas cordas efêmeras: uma de linhagem para a filha já aberta, outra para o cartão da filha fechada.
    expect(res.edges).toHaveLength(2);
    expect(res.edges.some((e) => e.source === "thread:parent" && e.target === "thread:open-child")).toBe(true);
    expect(res.edges.some((e) => e.source === "thread:parent" && e.target === res.cards[0]!.id)).toBe(true);
    // Não duplica a corda já persistida.
    expect(res.edges.some((e) => e.target === "thread:persisted-child")).toBe(false);
  });
});
