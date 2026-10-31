import { describe, expect, it } from "vitest";

import { addEdge, emptyBoard, reconcile, setRole, type Board } from "@/features/canvas/board";

import type { TeamMember, TeamView } from "../ipc";
import { canvasPlan, runCanvasPlan, type CanvasApi } from "../teamCanvas";
import { projectCanvas, reversePlan, roleIdOfLabel, type CanvasProjection, type ReverseOp } from "../teamMirror";

const LABEL = (role: string) => role.toUpperCase();
const ID_OF = (label: string) => label.toLowerCase();

function member(ref: string, role: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { teamId: "t1", member: ref, agentId: "codex", label: ref, role, model: null, policy: "ask", branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: false, ...extra };
}
function team(refs: [string, string, Partial<TeamMember>?][] = []): TeamView {
  return { id: "t1", orchestrator: "lead", agentId: "claude-code", label: "Lead", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: refs.length + 1, members: refs.map(([r, role, extra]) => member(r, role, extra)) };
}
/** Um canvas com a coroa no `lead` e as abas pedidas como nós. */
function board(ids: string[]): Board {
  return { ...reconcile(emptyBoard(), ["lead", ...ids]), orchestrators: ["lead"] };
}
const KEY = "main|/repo";
const TABS = new Set(["lead", "a", "b", "c"]);
const isAgentTab = (ref: string) => TABS.has(ref);

function plan(t: TeamView, boards: Record<string, Board>, baselines: Record<string, CanvasProjection>): ReverseOp[] {
  return reversePlan({ teams: [t], boards, baselines, isAgentTab, roleIdOf: ID_OF });
}
function baselineOf(t: TeamView, boards: Record<string, Board>): Record<string, CanvasProjection> {
  const projection = projectCanvas(t, boards, isAgentTab);
  return projection ? { [t.id]: projection } : {};
}

/** Executa o plano chat -> canvas num canvas de mentira. */
function fakeApi(boards: Record<string, Board>): CanvasApi {
  const get = (k: string) => boards[k] ?? emptyBoard();
  return {
    boards: () => boards,
    connect: (k, a, b) => { boards[k] = addEdge(get(k), a, b, `${a}-${b}`); },
    disconnectPair: (k, a, b) => { boards[k] = { ...get(k), edges: get(k).edges.filter((e) => !((e.a === a && e.b === b) || (e.a === b && e.b === a))) }; },
    toggleOrchestrator: (k, id) => { const b = get(k); boards[k] = { ...b, orchestrators: b.orchestrators.includes(id) ? b.orchestrators.filter((x) => x !== id) : [...b.orchestrators, id] }; },
    moveTerminals: () => undefined,
    setRole: (k, id, role, subagent) => { boards[k] = setRole(get(k), id, role, subagent); },
  };
}
const forward = (t: TeamView, boards: Record<string, Board>) =>
  canvasPlan({ team: t, boards, keyOfTab: (ref) => (TABS.has(ref) ? KEY : null), folderKey: () => KEY, roleLabel: LABEL });

describe("a projeção do canvas", () => {
  it("lê as cordas do orquestrador coroado, com papel e subagente", () => {
    const b = addEdge(board(["a", "b"]), "lead", "a", "e1");
    const boards = { [KEY]: setRole(b, "a", "FRONTEND", true) };
    expect(projectCanvas(team([["b", "qa"]]), boards, isAgentTab)).toEqual({
      a: { linked: true, role: "FRONTEND", subagent: true },
      b: { linked: false, role: null, subagent: false },
    });
  });

  it("sem coroa não há projeção (o time continua, só não espelha)", () => {
    const boards = { [KEY]: { ...addEdge(board(["a"]), "lead", "a", "e1"), orchestrators: [] } };
    expect(projectCanvas(team(), boards, isAgentTab)).toBeNull();
  });

  it("cordas para o que não é agente (nota, portal, conversa por protocolo) não contam", () => {
    const boards = { [KEY]: addEdge(addEdge(board(["a"]), "lead", "note-1", "e1"), "lead", "thread:x", "e2") };
    expect(projectCanvas(team(), boards, isAgentTab)).toEqual({});
  });

  it("canvas de missão não espelha no time", () => {
    const boards = { "main|/repo#m:1": addEdge(board(["a"]), "lead", "a", "e1") };
    expect(projectCanvas(team(), boards, isAgentTab)).toBeNull();
  });
});

describe("o sentido canvas -> chat", () => {
  it("corda nova entre o orquestrador e uma aba liga o integrante, com o papel e a marca do canvas", () => {
    const t = team();
    const before = { [KEY]: board(["a"]) };
    const base = baselineOf(t, before);
    const after = { [KEY]: setRole(addEdge(board(["a"]), "lead", "a", "e1"), "a", "FRONTEND", true) };
    expect(plan(t, after, base)).toEqual([{ kind: "link", teamId: "t1", ref: "a", role: "frontend", subagent: true }]);
  });

  it("corda sem papel liga com papel vazio (o time decide o padrão)", () => {
    const t = team();
    const base = baselineOf(t, { [KEY]: board(["a"]) });
    expect(plan(t, { [KEY]: addEdge(board(["a"]), "lead", "a", "e1") }, base)).toEqual([{ kind: "link", teamId: "t1", ref: "a", role: "", subagent: false }]);
  });

  it("corda removida desliga o integrante", () => {
    const t = team([["a", "qa"]]);
    const linked = { [KEY]: addEdge(board(["a"]), "lead", "a", "e1") };
    const base = baselineOf(t, linked);
    expect(plan(t, { [KEY]: board(["a"]) }, base)).toEqual([{ kind: "unlink", teamId: "t1", ref: "a" }]);
  });

  it("papel e subagente mudados no canvas atualizam só o que mudou", () => {
    const t = team([["a", "qa"]]);
    const start = setRole(addEdge(board(["a"]), "lead", "a", "e1"), "a", "QA", false);
    const base = baselineOf(t, { [KEY]: start });
    expect(plan(t, { [KEY]: setRole(start, "a", "BACKEND", false) }, base)).toEqual([{ kind: "update", teamId: "t1", ref: "a", role: "backend" }]);
    expect(plan(t, { [KEY]: setRole(start, "a", "QA", true) }, base)).toEqual([{ kind: "update", teamId: "t1", ref: "a", subagent: true }]);
    expect(plan(t, { [KEY]: setRole(start, "a", "BACKEND", true) }, base)).toEqual([{ kind: "update", teamId: "t1", ref: "a", role: "backend", subagent: true }]);
  });

  it("tirar a coroa não desfaz o time nem gera operação", () => {
    const t = team([["a", "qa"]]);
    const start = addEdge(board(["a"]), "lead", "a", "e1");
    const base = baselineOf(t, { [KEY]: start });
    expect(plan(t, { [KEY]: { ...start, orchestrators: [] } }, base)).toEqual([]);
  });

  it("sem linha de base o plano não adivinha: só adota", () => {
    const t = team();
    expect(plan(t, { [KEY]: addEdge(board(["a"]), "lead", "a", "e1") }, {})).toEqual([]);
  });

  it("não liga quem já é de outro time ou o próprio orquestrador de outro", () => {
    const other: TeamView = { ...team([["a", "qa"]]), id: "t2", orchestrator: "b" };
    const mine = team();
    const base = baselineOf(mine, { [KEY]: board(["a", "b"]) });
    const boards = { [KEY]: addEdge(addEdge(board(["a", "b"]), "lead", "a", "e1"), "lead", "b", "e2") };
    expect(reversePlan({ teams: [mine, other], boards, baselines: { t1: base.t1! }, isAgentTab, roleIdOf: ID_OF })).toEqual([]);
  });

  it("aba fechada não conta como corda removida", () => {
    const t = team([["c", "qa"]]);
    const open = new Set(["lead", "c"]);
    const linked = { [KEY]: addEdge(board(["c"]), "lead", "c", "e1") };
    const baseline = { t1: projectCanvas(t, linked, (r) => open.has(r))! };
    open.delete("c");
    expect(reversePlan({ teams: [t], boards: { [KEY]: board([]) }, baselines: baseline, isAgentTab: (r) => open.has(r), roleIdOf: ID_OF })).toEqual([]);
  });
});

describe("convergência sem laço", () => {
  it("chat -> canvas -> chat: na segunda passada não há operação em nenhum sentido", () => {
    const t = team([["a", "frontend", { subagent: true }], ["b", "qa"]]);
    const boards: Record<string, Board> = { [KEY]: board(["a", "b"]) };
    const ops = forward(t, boards);
    expect(ops.length).toBeGreaterThan(0);
    runCanvasPlan(ops, fakeApi(boards));
    const base = baselineOf(t, boards);
    expect(plan(t, boards, base)).toEqual([]);
    expect(forward(t, boards)).toEqual([]);
    expect(boards[KEY]!.subagents).toEqual(["a"]);
  });

  it("canvas -> chat -> canvas: o que a pessoa fez no canvas volta ao canvas sem diferença", () => {
    let t = team();
    const boards: Record<string, Board> = { [KEY]: board(["a"]) };
    const base = baselineOf(t, boards);
    boards[KEY] = setRole(addEdge(boards[KEY]!, "lead", "a", "e1"), "a", "FRONTEND", true);
    const ops = plan(t, boards, base);
    expect(ops).toHaveLength(1);
    // O backend grava o integrante como o canvas pediu.
    const link = ops[0] as Extract<ReverseOp, { kind: "link" }>;
    t = team([[link.ref, link.role, { subagent: link.subagent }]]);
    expect(forward(t, boards)).toEqual([]);
    expect(plan(t, boards, baselineOf(t, boards))).toEqual([]);
  });

  it("sem papel no canvas, o time dá o padrão e o canvas recebe o rótulo uma vez só", () => {
    let t = team();
    const boards: Record<string, Board> = { [KEY]: board(["a"]) };
    const base = baselineOf(t, boards);
    boards[KEY] = addEdge(boards[KEY]!, "lead", "a", "e1");
    const [link] = plan(t, boards, base) as [Extract<ReverseOp, { kind: "link" }>];
    t = team([[link.ref, "generalist"]]);
    const first = forward(t, boards);
    expect(first).toEqual([{ kind: "role", key: KEY, id: "a", label: "GENERALIST", subagent: false }]);
    runCanvasPlan(first, fakeApi(boards));
    expect(forward(t, boards)).toEqual([]);
    expect(plan(t, boards, baselineOf(t, boards))).toEqual([]);
  });

  it("a última ação da pessoa vence: a mudança do chat (já aplicada ao canvas) não volta como mudança do canvas", () => {
    const boards: Record<string, Board> = { [KEY]: board(["a"]) };
    // O chat mudou o papel; o canvas é posto em dia e a linha de base acompanha.
    const changed = team([["a", "backend"]]);
    runCanvasPlan(forward(changed, boards), fakeApi(boards));
    const adopted = baselineOf(changed, boards);
    expect(plan(changed, boards, adopted)).toEqual([]);
  });
});

describe("roleIdOfLabel", () => {
  const names: Record<string, string> = { frontend: "Frontend (UI)", qa: "QA" };
  const label = (id: string) => names[id] ?? id;
  it("acha o papel pelo nome no idioma da tela ou pelo id", () => {
    expect(roleIdOfLabel("Frontend (UI)", ["frontend", "qa"], label)).toBe("frontend");
    expect(roleIdOfLabel("qa", ["frontend", "qa"], label)).toBe("qa");
  });
  it("um papel que não é do catálogo do time vai como o rótulo", () => {
    expect(roleIdOfLabel("  Arquiteto ", ["frontend", "qa"], label)).toBe("Arquiteto");
  });
});
