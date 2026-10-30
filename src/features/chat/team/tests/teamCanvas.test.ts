import { describe, expect, it } from "vitest";

import { addEdge, emptyBoard, reconcile, type Board } from "@/features/canvas/board";

import type { TeamMember, TeamView } from "../ipc";
import { canvasPlan, leadBoardKey, runCanvasPlan, type CanvasApi, type CanvasInput } from "../teamCanvas";

function member(ref: string, role: string): TeamMember {
  return { teamId: "t1", member: ref, agentId: "codex", label: ref, role, model: null, policy: "ask", branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: false };
}

function team(orchestrator: string, refs: [string, string][]): TeamView {
  return { id: "t1", orchestrator, agentId: "claude-code", label: "Lead", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: refs.length + 1, members: refs.map(([r, role]) => member(r, role)) };
}

function withNodes(ids: string[]): Board {
  return reconcile(emptyBoard(), ids);
}

/** Um canvas de mentira, com as mesmas funções puras do `board.ts`. */
function fakeApi(boards: Record<string, Board>): CanvasApi & { boards: () => Record<string, Board> } {
  const get = (k: string) => boards[k] ?? emptyBoard();
  return {
    boards: () => boards,
    connect: (k, a, b) => { boards[k] = addEdge(get(k), a, b, `${a}-${b}`); },
    disconnectPair: (k, a, b) => { boards[k] = { ...get(k), edges: get(k).edges.filter((e) => !((e.a === a && e.b === b) || (e.a === b && e.b === a))) }; },
    toggleOrchestrator: (k, id) => { const b = get(k); boards[k] = { ...b, orchestrators: b.orchestrators.includes(id) ? b.orchestrators.filter((x) => x !== id) : [...b.orchestrators, id] }; },
    moveTerminals: (from, to, ids) => {
      const f = get(from); const tb = get(to);
      const nodes = { ...tb.nodes };
      for (const id of ids) if (f.nodes[id]) nodes[id] = f.nodes[id]!;
      const rest = Object.fromEntries(Object.entries(f.nodes).filter(([id]) => !ids.includes(id)));
      boards[to] = { ...tb, nodes };
      boards[from] = { ...f, nodes: rest };
    },
    setRole: (k, id, role, subagent) => {
      const b = get(k);
      const others = b.subagents.filter((x) => x !== id);
      boards[k] = { ...b, roles: { ...b.roles, [id]: role ?? "" }, subagents: subagent ? [...others, id] : others };
    },
  };
}

function input(t: TeamView, boards: Record<string, Board>, tabKeys: Record<string, string>, extra: Partial<CanvasInput> = {}): CanvasInput {
  return { team: t, boards, keyOfTab: (ref) => tabKeys[ref] ?? null, folderKey: (cwd) => `main|${cwd}`, roleLabel: (r) => r.toUpperCase(), ...extra };
}

describe("o time no canvas", () => {
  it("coroa o orquestrador, traz as abas para o canvas dele e liga cada um com o papel", () => {
    const boards: Record<string, Board> = { "main|/repo": withNodes(["lead"]), "main|/wt": withNodes(["ui"]) };
    const t = team("lead", [["ui", "frontend"], ["thread:x", "qa"]]);
    const tabs = { lead: "main|/repo", ui: "main|/wt" };
    const ops = canvasPlan(input(t, boards, tabs));
    expect(ops).toEqual([
      { kind: "crown", key: "main|/repo", id: "lead" },
      { kind: "move", from: "main|/wt", to: "main|/repo", ids: ["ui"] },
      { kind: "connect", key: "main|/repo", a: "lead", b: "ui" },
      { kind: "role", key: "main|/repo", id: "ui", label: "FRONTEND", subagent: false },
      { kind: "connect", key: "main|/repo", a: "lead", b: "thread:x" },
      { kind: "role", key: "main|/repo", id: "thread:x", label: "QA", subagent: false },
    ]);
    const api = fakeApi(boards);
    expect(runCanvasPlan(ops, api).sort()).toEqual(["main|/repo", "main|/wt"]);
    const lead = boards["main|/repo"]!;
    expect(lead.orchestrators).toEqual(["lead"]);
    expect(Object.keys(lead.nodes).sort()).toEqual(["lead", "ui"]);
    expect(lead.edges.map((e) => e.b)).toEqual(["ui", "thread:x"]);
    // De novo: já está certo, nada a fazer.
    expect(canvasPlan(input(t, boards, tabs))).toEqual([]);
  });

  it("a corda de uma conversa por protocolo sobrevive à reconciliação das abas", () => {
    const board = addEdge({ ...withNodes(["lead"]), orchestrators: ["thread:o"] }, "thread:o", "lead", "e1");
    const next = reconcile(board, ["lead"]);
    expect(next.edges).toHaveLength(1);
    expect(next.orchestrators).toEqual(["thread:o"]);
  });

  it("orquestrador por protocolo: a corda fica no canvas da pasta e ninguém é movido", () => {
    const boards: Record<string, Board> = { "main|/wt": withNodes(["ui"]) };
    const t = team("thread:o", [["ui", "frontend"]]);
    expect(leadBoardKey(input(t, boards, { ui: "main|/wt" }))).toBe("main|/repo");
    const ops = canvasPlan(input(t, boards, { ui: "main|/wt" }));
    expect(ops.some((op) => op.kind === "move")).toBe(false);
    expect(ops).toContainEqual({ kind: "connect", key: "main|/repo", a: "thread:o", b: "ui" });
  });

  it("quem é de uma missão fica nela; aba fechada fica para quando abrir", () => {
    const boards: Record<string, Board> = { "main|/repo": withNodes(["lead"]), "main|/repo#m:m1": withNodes(["qa"]) };
    const t = team("lead", [["qa", "qa"], ["fechada", "qa"]]);
    const ops = canvasPlan(input(t, boards, { lead: "main|/repo", qa: "main|/repo#m:m1" }));
    expect(ops.some((op) => op.kind === "move")).toBe(false);
    expect(ops.some((op) => "b" in op && op.b === "fechada")).toBe(false);
  });

  it("com o orquestrador (aba) ainda fechado, não mexe em nada", () => {
    const boards: Record<string, Board> = { "main|/wt": withNodes(["ui"]) };
    expect(canvasPlan(input(team("lead", [["ui", "frontend"]]), boards, { ui: "main|/wt" }))).toEqual([]);
  });

  it("desligar tira a corda; desfazer tira as cordas e a coroa", () => {
    const boards: Record<string, Board> = { "main|/repo": { ...addEdge(addEdge(withNodes(["lead", "a", "b"]), "lead", "a", "1"), "lead", "b", "2"), orchestrators: ["lead"] } };
    const t = team("lead", [["a", "qa"]]);
    const api = fakeApi(boards);
    runCanvasPlan(canvasPlan(input(t, boards, { lead: "main|/repo", a: "main|/repo", b: "main|/repo" }, { removed: ["b"] })), api);
    expect(boards["main|/repo"]!.edges.map((e) => e.b)).toEqual(["a"]);
    runCanvasPlan(canvasPlan(input(t, boards, { lead: "main|/repo", a: "main|/repo" }, { dissolve: true })), api);
    expect(boards["main|/repo"]!.edges).toEqual([]);
    expect(boards["main|/repo"]!.orchestrators).toEqual([]);
  });

  it("espelha o subagente do time no canvas, liga e desliga", () => {
    const boards: Record<string, Board> = { "main|/repo": withNodes(["lead", "ui"]) };
    const tabs = { lead: "main|/repo", ui: "main|/repo" };
    const t = team("lead", [["ui", "frontend"]]);
    t.members[0]!.subagent = true;
    const on = canvasPlan(input(t, boards, tabs)).filter((op) => op.kind === "role");
    expect(on).toEqual([{ kind: "role", key: "main|/repo", id: "ui", label: "FRONTEND", subagent: true }]);
    runCanvasPlan(on, fakeApi(boards));
    expect(boards["main|/repo"]!.subagents).toEqual(["ui"]);
    expect(canvasPlan(input(t, boards, tabs)).filter((op) => op.kind === "role")).toEqual([]);
    t.members[0]!.subagent = false;
    const off = canvasPlan(input(t, boards, tabs)).filter((op) => op.kind === "role");
    expect(off).toEqual([{ kind: "role", key: "main|/repo", id: "ui", label: "FRONTEND", subagent: false }]);
    runCanvasPlan(off, fakeApi(boards));
    expect(boards["main|/repo"]!.subagents).toEqual([]);
  });

  it("a conversa por protocolo não ganha a marca no canvas", () => {
    const boards: Record<string, Board> = { "main|/repo": withNodes(["lead"]) };
    const t = team("lead", [["thread:x", "qa"]]);
    t.members[0]!.subagent = true;
    const roles = canvasPlan(input(t, boards, { lead: "main|/repo" })).filter((op) => op.kind === "role");
    expect(roles).toEqual([{ kind: "role", key: "main|/repo", id: "thread:x", label: "QA", subagent: false }]);
  });
});
