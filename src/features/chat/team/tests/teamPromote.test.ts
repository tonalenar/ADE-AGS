import { describe, expect, it } from "vitest";

import { addEdge, emptyBoard, reconcile, setRole, type Board } from "@/features/canvas/board";

import type { TeamMember, TeamView } from "../ipc";
import { canvasPlan } from "../teamCanvas";
import { missionRefsOf, projectCanvas, promotePlan, reversePlan, type PromoteAgent } from "../teamMirror";

const KEY = "main|/repo";
const ID_OF = (label: string) => label.toLowerCase();
const AGENTS: PromoteAgent[] = ["lead", "a", "b", "c", "other"].map((ref) => ({ ref, agentId: ref === "lead" ? "claude-code" : "codex", label: ref, title: ref, cwd: "/repo" }));
const SHELLLESS = new Set(AGENTS.map((a) => a.ref));
const isAgentTab = (ref: string) => SHELLLESS.has(ref);

function crowned(ids: string[], lead = "lead"): Board {
  return { ...reconcile(emptyBoard(), [lead, ...ids]), orchestrators: [lead] };
}
function member(ref: string, role: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { teamId: "t1", member: ref, agentId: "codex", label: ref, role, model: null, policy: "ask", branch: null, worktree: null, origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: false, ...extra };
}
function team(orchestrator: string, members: TeamMember[] = [], id = "t1"): TeamView {
  return { id, orchestrator, agentId: "claude-code", label: orchestrator, cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: members.length + 1, members: members.map((m) => ({ ...m, teamId: id })) };
}

describe("promotePlan: a coroa do canvas vira time do chat", () => {
  it("coroa sem time e com corda a agente promove, com papel, subagente e a chave do canvas", () => {
    const b = setRole(addEdge(addEdge(crowned(["a", "b"]), "lead", "a", "e1"), "lead", "b", "e2"), "a", "QA", true);
    const ops = promotePlan({ [KEY]: b }, [], AGENTS, { roleIdOf: ID_OF });
    expect(ops).toEqual([{
      orchestrator: AGENTS[0],
      boardKey: KEY,
      members: [
        { member: "a", agentId: "codex", label: "a", role: "qa", subagent: true },
        { member: "b", agentId: "codex", label: "b", role: "", subagent: false },
      ],
    }]);
  });

  it("coroa sem nenhuma corda a agente não promove", () => {
    const b = addEdge(crowned(["a"]), "lead", "note-1", "e1");
    expect(promotePlan({ [KEY]: b }, [], AGENTS)).toEqual([]);
    expect(promotePlan({ [KEY]: crowned(["a"]) }, [], AGENTS)).toEqual([]);
  });

  it("missão fica fora (#m:), e o comparador também", () => {
    const b = addEdge(crowned(["a"]), "lead", "a", "e1");
    expect(promotePlan({ "main|/repo#m:1": b }, [], AGENTS)).toEqual([]);
    expect(promotePlan({ "main|/repo#cmp:1": b }, [], AGENTS)).toEqual([]);
  });

  it("canvas de projeto (#c:) promove", () => {
    const b = addEdge(crowned(["a"]), "lead", "a", "e1");
    const ops = promotePlan({ "main|/repo#c:7": b }, [], AGENTS);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.boardKey).toBe("main|/repo#c:7");
  });

  it("a coroa que já lidera um time não promove de novo", () => {
    const b = addEdge(crowned(["a"]), "lead", "a", "e1");
    expect(promotePlan({ [KEY]: b }, [team("lead")], AGENTS)).toEqual([]);
  });

  it("agentes de outro time ou de missão ficam de fora; sem sobrar cordado, não promove", () => {
    const b = addEdge(addEdge(crowned(["a", "b"]), "lead", "a", "e1"), "lead", "b", "e2");
    const other = team("other", [member("a", "qa")], "t2");
    const boards = { [KEY]: b, "main|/repo#m:1": { ...crowned(["b"], "other"), orchestrators: ["other"] } };
    expect(promotePlan(boards, [other], AGENTS)).toEqual([]);
    const one = promotePlan({ [KEY]: b }, [other], AGENTS);
    expect(one[0]!.members.map((m) => m.member)).toEqual(["b"]);
  });

  it("a coroa que é integrante de outro time com orquestrador não promove", () => {
    const b = addEdge(crowned(["a"]), "lead", "a", "e1");
    expect(promotePlan({ [KEY]: b }, [team("other", [member("lead", "qa")], "t2")], AGENTS)).toEqual([]);
  });

  it("time sem orquestrador pode ser reassumido pela coroa (o backend adota)", () => {
    const b = addEdge(crowned(["a"]), "lead", "a", "e1");
    expect(promotePlan({ [KEY]: b }, [team("", [member("a", "qa")])], AGENTS)).toHaveLength(1);
  });

  it("só olha os canvases pedidos (a pessoa mexeu ali)", () => {
    const b = addEdge(crowned(["a"]), "lead", "a", "e1");
    expect(promotePlan({ [KEY]: b }, [], AGENTS, { only: ["outro"] })).toEqual([]);
    expect(promotePlan({ [KEY]: b }, [], AGENTS, { only: [KEY] })).toHaveLength(1);
  });

  it("agente fora da lista (shell, aba fechada) não vira orquestrador nem cordado", () => {
    const b = addEdge(crowned(["a"]), "lead", "a", "e1");
    expect(promotePlan({ [KEY]: b }, [], AGENTS.filter((x) => x.ref !== "lead"))).toEqual([]);
    expect(promotePlan({ [KEY]: b }, [], AGENTS.filter((x) => x.ref !== "a"))).toEqual([]);
  });

  it("conversa por protocolo cordada entra quando está na lista", () => {
    const b = addEdge(crowned([]), "lead", "thread:9", "e1");
    const agents = [...AGENTS, { ref: "thread:9", agentId: "codex", label: "T", title: "T", cwd: "/repo" }];
    expect(promotePlan({ [KEY]: b }, [], agents)[0]!.members.map((m) => m.member)).toEqual(["thread:9"]);
  });
});

describe("missionRefsOf", () => {
  it("junta nós e coroas dos canvases de missão", () => {
    const refs = missionRefsOf({ [KEY]: crowned(["a"]), "x#m:1": { ...crowned(["b"], "other"), orchestrators: ["other"] } });
    expect([...refs].sort()).toEqual(["b", "other"]);
  });
});

describe("o invariante de um time só inclui a missão", () => {
  it("reversePlan não liga ao time quem é integrante de missão", () => {
    const t = team("lead");
    const boards = { [KEY]: addEdge(crowned(["a"]), "lead", "a", "e1"), "x#m:1": crowned(["a"], "other") };
    const base = { t1: { a: { linked: false, role: null, subagent: false } } };
    expect(reversePlan({ teams: [t], boards, baselines: base, isAgentTab, roleIdOf: ID_OF })).toEqual([]);
  });
});

describe("coroa tirada: só o papel de orquestrador", () => {
  const withMember = team("lead", [member("a", "qa")]);
  const crown = addEdge(crowned(["a"]), "lead", "a", "e1");
  const baseline = { t1: projectCanvas(withMember, { [KEY]: crown }, isAgentTab)! };

  it("sem a coroa, com a conversa ainda aberta e linha de base, o plano pede unlead (e nada mais)", () => {
    const uncrowned = { [KEY]: { ...crown, orchestrators: [] } };
    expect(reversePlan({ teams: [withMember], boards: uncrowned, baselines: baseline, isAgentTab, roleIdOf: ID_OF })).toEqual([{ kind: "unlead", teamId: "t1" }]);
  });

  it("a conversa fechada leva a coroa junto (reconcile): não é gesto da pessoa", () => {
    const uncrowned = { [KEY]: { ...crown, orchestrators: [] } };
    const closed = (ref: string) => ref !== "lead" && isAgentTab(ref);
    expect(reversePlan({ teams: [withMember], boards: uncrowned, baselines: baseline, isAgentTab: closed, roleIdOf: ID_OF })).toEqual([]);
  });

  it("sem linha de base (nunca esteve coroado aqui) não faz nada", () => {
    expect(reversePlan({ teams: [withMember], boards: { [KEY]: { ...crown, orchestrators: [] } }, baselines: {}, isAgentTab, roleIdOf: ID_OF })).toEqual([]);
  });

  it("coroa em outro canvas continua coroa: nada a fazer", () => {
    const moved = { [KEY]: { ...crown, orchestrators: [] }, "outro|/x": crown };
    expect(reversePlan({ teams: [withMember], boards: moved, baselines: baseline, isAgentTab, roleIdOf: ID_OF })).toEqual([]);
  });

  it("time sem orquestrador não gera plano para o canvas (nada de coroar \"\")", () => {
    const orphan = team("", [member("a", "qa")]);
    expect(canvasPlan({ team: orphan, boards: { [KEY]: crown }, keyOfTab: () => KEY, folderKey: () => KEY, roleLabel: (r) => r })).toEqual([]);
  });
});

describe("idempotência: promover e espelhar de volta não deixa nada a fazer", () => {
  it("promotePlan -> time criado -> canvasPlan, reversePlan e promotePlan vazios", () => {
    const b = setRole(addEdge(addEdge(crowned(["a", "b"]), "lead", "a", "e1"), "lead", "b", "e2"), "a", "QA", true);
    const boards = { [KEY]: b };
    const [op] = promotePlan(boards, [], AGENTS, { roleIdOf: ID_OF });
    // O que `chat_team_promote` grava.
    const created = team(op!.orchestrator.ref, op!.members.map((m) => member(m.member, m.role, { subagent: m.subagent })));
    const label = (role: string) => role.toUpperCase();
    expect(canvasPlan({ team: created, boards, keyOfTab: () => KEY, folderKey: () => KEY, roleLabel: label })).toEqual([]);
    const baselines = { t1: projectCanvas(created, boards, isAgentTab)! };
    expect(reversePlan({ teams: [created], boards, baselines, isAgentTab, roleIdOf: ID_OF })).toEqual([]);
    expect(promotePlan(boards, [created], AGENTS, { roleIdOf: ID_OF })).toEqual([]);
  });
});
