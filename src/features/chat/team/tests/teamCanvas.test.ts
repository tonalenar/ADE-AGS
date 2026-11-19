import { describe, expect, it } from "vitest";

import { addEdge, moveSessionArtifacts, emptyBoard, reconcile, setRole, type Board } from "@/features/canvas/board";

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
    migrateSession: (from, to, id) => { const moved = moveSessionArtifacts(get(from), get(to), id); boards[to] = moved.target; boards[from] = moved.source; },
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
      { kind: "migrate", from: "main|/repo", to: "main|/repo#s:lead", ids: ["lead"] },
      { kind: "crown", key: "main|/repo#s:lead", id: "lead" },
      { kind: "migrate", from: "main|/wt", to: "main|/repo#s:lead", ids: ["ui"] },
      { kind: "connect", key: "main|/repo#s:lead", a: "lead", b: "ui" },
      { kind: "role", key: "main|/repo#s:lead", id: "ui", label: "FRONTEND", subagent: false },
      { kind: "connect", key: "main|/repo#s:lead", a: "lead", b: "thread:x" },
      { kind: "role", key: "main|/repo#s:lead", id: "thread:x", label: "QA", subagent: false },
    ]);
    const api = fakeApi(boards);
    expect(runCanvasPlan(ops, api).sort()).toEqual(["main|/repo", "main|/repo#s:lead", "main|/wt"]);
    const lead = boards["main|/repo#s:lead"]!;
    expect(lead.orchestrators).toEqual(["lead"]);
    expect(Object.keys(lead.nodes).sort()).toEqual(["lead", "ui"]);
    expect(lead.edges.map((e) => e.b)).toEqual(["ui", "thread:x"]);
    // Movidos, não copiados: a pasta e o worktree não ficam com um segundo nó deles.
    expect(Object.keys(boards["main|/repo"]!.nodes)).toEqual([]);
    expect(Object.keys(boards["main|/wt"]!.nodes)).toEqual([]);
    // De novo: já está certo, nada a fazer.
    expect(canvasPlan(input(t, boards, tabs))).toEqual([]);
  });

  it("move o integrante do canvas próprio antigo para o do orquestrador, com papel e marca", () => {
    const leadKey = "main|/repo#s:lead";
    const memberKey = "main|/wt#s:ui";
    const source = setRole(withNodes(["ui"]), "ui", "QA", true);
    const boards: Record<string, Board> = { [leadKey]: withNodes(["lead"]), [memberKey]: source };
    const tabs = { lead: leadKey, ui: leadKey };
    const t = team("lead", [["ui", "frontend"]]);
    const ops = canvasPlan(input(t, boards, tabs, { sourceKeyOfRef: (ref) => ref === "ui" ? memberKey : leadKey }));
    expect(ops).toContainEqual({ kind: "migrate", from: memberKey, to: leadKey, ids: ["ui"] });
    runCanvasPlan(ops, fakeApi(boards));
    expect(boards[memberKey]).toMatchObject({ nodes: {}, roles: {}, subagents: [] });
    expect(boards[leadKey]).toMatchObject({ nodes: { ui: source.nodes.ui }, edges: [{ a: "lead", b: "ui" }] });
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
    expect(leadBoardKey(input(t, boards, { ui: "main|/wt" }))).toBe("main|/repo#s:thread:o");
    const ops = canvasPlan(input(t, boards, { ui: "main|/wt" }));
    expect(ops.some((op) => op.kind === "move")).toBe(false);
    expect(ops).toContainEqual({ kind: "connect", key: "main|/repo#s:thread:o", a: "thread:o", b: "ui" });
  });

  it("orquestrador por protocolo já presente num canvas de projeto mantém o escopo", () => {
    const key = "main|/repo#c:legacy";
    const boards = { [key]: { ...emptyBoard(), threads: { "thread:o": { x: 0, y: 0, w: 100, h: 100 } } } };
    expect(leadBoardKey(input(team("thread:o", []), boards, {}))).toBe(key);
  });

  it("orquestrador por protocolo já nó de qualquer canvas #s: mantém esse canvas", () => {
    const key = "main|/repo#s:thread:origin";
    const boards = { [key]: { ...emptyBoard(), threads: { "thread:o": { x: 0, y: 0, w: 100, h: 100 } } } };
    expect(leadBoardKey(input(team("thread:o", []), boards, {}))).toBe(key);
  });

  it("time promovido do canvas da pasta permanece junto com as cordas e a coroa antigas", () => {
    const key = "main|/repo";
    const board = {
      ...addEdge(withNodes(["lead", "ui"]), "lead", "ui", "e1"),
      orchestrators: ["lead"],
      roles: { ui: "FRONTEND" },
    };
    const t = { ...team("lead", [["ui", "frontend"]]), origin: "canvas" as const, boardKey: key };
    const boards = { [key]: board };
    const tabs = { lead: key, ui: key };
    expect(leadBoardKey(input(t, boards, tabs))).toBe(key);
    expect(canvasPlan(input(t, boards, tabs))).toEqual([]);
    expect(boards[key]).toMatchObject({ edges: [{ id: "e1", a: "lead", b: "ui" }], orchestrators: ["lead"], roles: { ui: "FRONTEND" } });
  });

  it("move o cartão de um integrante por protocolo para a sessão do orquestrador", () => {
    const leadKey = "main|/repo#s:thread:lead";
    const memberKey = "main|/other#s:thread:member";
    const box = { x: 12, y: 34, w: 460, h: 540 };
    const source = { ...emptyBoard(), threads: { "thread:member": box } };
    const boards: Record<string, Board> = { [memberKey]: source };
    const t = team("thread:lead", [["thread:member", "qa"]]);
    const ops = canvasPlan(input(t, boards, {}, { sourceKeyOfRef: (ref) => ref === "thread:member" ? memberKey : null }));
    expect(ops).toContainEqual({ kind: "migrate", from: memberKey, to: leadKey, ids: ["thread:member"] });
    runCanvasPlan(ops, fakeApi(boards));
    expect(boards[memberKey]!.threads["thread:member"]).toBeUndefined();
    expect(boards[leadKey]!.threads["thread:member"]).toEqual(box);
    expect(boards[leadKey]!.edges).toContainEqual({ id: "thread:lead-thread:member", a: "thread:lead", b: "thread:member" });
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
    // O backend autoriza por corda e coroa em QUALQUER canvas: a conferência olha todos.
    const edges = () => Object.values(boards).flatMap((board) => board.edges);
    runCanvasPlan(canvasPlan(input(t, boards, { lead: "main|/repo", a: "main|/repo", b: "main|/repo" }, { removed: ["b"] })), api);
    expect(edges().map((e) => [e.a, e.b].sort().join("-"))).toEqual(["a-lead"]);
    runCanvasPlan(canvasPlan(input(t, boards, { lead: "main|/repo", a: "main|/repo" }, { dissolve: true })), api);
    expect(edges()).toEqual([]);
    expect(Object.values(boards).flatMap((board) => board.orchestrators)).toEqual([]);
  });

  it("espelha o subagente do time no canvas, liga e desliga", () => {
    const boards: Record<string, Board> = { "main|/repo": withNodes(["lead", "ui"]) };
    const tabs = { lead: "main|/repo", ui: "main|/repo" };
    const t = team("lead", [["ui", "frontend"]]);
    t.members[0]!.subagent = true;
    const on = canvasPlan(input(t, boards, tabs)).filter((op) => op.kind === "role");
    expect(on).toEqual([{ kind: "role", key: "main|/repo#s:lead", id: "ui", label: "FRONTEND", subagent: true }]);
    runCanvasPlan(on, fakeApi(boards));
    expect(boards["main|/repo#s:lead"]!.subagents).toEqual(["ui"]);
    expect(canvasPlan(input(t, boards, tabs)).filter((op) => op.kind === "role")).toEqual([]);
    t.members[0]!.subagent = false;
    const off = canvasPlan(input(t, boards, tabs)).filter((op) => op.kind === "role");
    expect(off).toEqual([{ kind: "role", key: "main|/repo#s:lead", id: "ui", label: "FRONTEND", subagent: false }]);
    runCanvasPlan(off, fakeApi(boards));
    expect(boards["main|/repo#s:lead"]!.subagents).toEqual([]);
  });

  it("a conversa por protocolo também espelha a marca de subagente no canvas", () => {
    const boards: Record<string, Board> = { "main|/repo": withNodes(["lead"]) };
    const t = team("lead", [["thread:x", "qa"]]);
    t.members[0]!.subagent = true;
    const on = canvasPlan(input(t, boards, { lead: "main|/repo" })).filter((op) => op.kind === "role");
    expect(on).toEqual([{ kind: "role", key: "main|/repo#s:lead", id: "thread:x", label: "QA", subagent: true }]);
    runCanvasPlan(on, fakeApi(boards));
    expect(boards["main|/repo#s:lead"]!.subagents).toEqual(["thread:x"]);
    t.members[0]!.subagent = false;
    const off = canvasPlan(input(t, boards, { lead: "main|/repo" })).filter((op) => op.kind === "role");
    expect(off).toEqual([{ kind: "role", key: "main|/repo#s:lead", id: "thread:x", label: "QA", subagent: false }]);
  });
});
