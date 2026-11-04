import { describe, expect, it } from "vitest";

import { emptyBoard, type Board } from "@/features/canvas/board";
import type { TeamMember, TeamView } from "@/features/chat/team/ipc";
import type { ThreadRow } from "@/features/chat/structured/ipc";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";

import { conversationOf, selectConversations, teamConversations, type UnifiedSources } from "../selectConversations";

const tab = (id: string, over: Partial<Tab> = {}): Tab => ({
  id, title: id, cwd: "/p", agentId: "claude-code", agentLabel: "Claude Code", command: "claude", ptyId: 1, openedAt: 10, ...over,
});
const thread = (id: string, over: Partial<ThreadRow> = {}): ThreadRow => ({
  id, agentId: "codex", cwd: "/p", title: `t-${id}`, model: null, effort: null, access: "ask", accountId: null, state: "active",
  createdAt: 1, updatedAt: 20, ...over,
});
const member = (teamId: string, ref: string, role: string, over: Partial<TeamMember> = {}): TeamMember => ({
  teamId, member: ref, agentId: "claude-code", label: "x", role, model: null, policy: "ask", branch: null, worktree: null,
  origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: false, ...over,
});
const team = (id: string, orchestrator: string, members: TeamMember[], over: Partial<TeamView> = {}): TeamView => ({
  id, orchestrator, agentId: "claude-code", label: "x", cwd: "/p", title: "Time", createdAt: 1, updatedAt: 1, members, headcount: members.length + 1, ...over,
});
const board = (nodeIds: string[]): Board => ({ ...emptyBoard(), nodes: Object.fromEntries(nodeIds.map((id) => [id, { x: 0, y: 0, w: 1, h: 1 }])) as Board["nodes"] });
const src = (over: Partial<UnifiedSources> = {}): UnifiedSources => ({ tabs: [], threads: [], teams: [], boards: {}, ...over });

describe("selectConversations", () => {
  it("uma aba de agente vira conversa pty com a própria id como ref", () => {
    const [c] = selectConversations(src({ tabs: [tab("t1", { title: "Refatorar", cwd: "/repo" })] }));
    expect(c).toMatchObject({ ref: "t1", kind: "pty", agentId: "claude-code", cwd: "/repo", title: "Refatorar", openedAt: 10 });
    expect(c!.teamId).toBeUndefined();
  });

  it("terminal de shell não é conversa", () => {
    expect(selectConversations(src({ tabs: [tab("sh", { agentId: SHELL_AGENT_ID })] }))).toEqual([]);
  });

  it("conversa por protocolo usa thread:<id>; só as ativas entram", () => {
    const out = selectConversations(src({ threads: [thread("a"), thread("b", { state: "settled" })] }));
    expect(out.map((c) => c.ref)).toEqual(["thread:a"]);
    expect(out[0]).toMatchObject({ kind: "protocol", agentId: "codex", title: "t-a", openedAt: 20 });
  });

  it("ordena a mais recente primeiro, misturando pty e protocolo", () => {
    const out = selectConversations(src({ tabs: [tab("t1", { openedAt: 30 }), tab("t2", { openedAt: 5 })], threads: [thread("a")] }));
    expect(out.map((c) => c.ref)).toEqual(["t1", "thread:a", "t2"]);
  });

  it("integrante e orquestrador carregam time, papel, origem e coroa", () => {
    const tm = team("T", "t1", [member("T", "t2", "Revisor"), member("T", "thread:a", "Apoio", { subagent: true })], { origin: "canvas", boardKey: "main|/p" });
    const out = selectConversations(src({ tabs: [tab("t1"), tab("t2")], threads: [thread("a")], teams: [tm] }));
    const by = Object.fromEntries(out.map((c) => [c.ref, c]));
    expect(by.t1).toMatchObject({ teamId: "T", lead: true, origin: "canvas", boardKey: "main|/p" });
    expect(by.t2).toMatchObject({ teamId: "T", role: "Revisor", lead: false, subagent: false });
    expect(by["thread:a"]).toMatchObject({ teamId: "T", role: "Apoio", subagent: true, kind: "protocol" });
  });

  it("time sem origem (backend antigo) é do chat", () => {
    const [c] = selectConversations(src({ tabs: [tab("t1")], teams: [team("T", "t1", [])] }));
    expect(c!.origin).toBe("chat");
  });

  it("time de missão traz a missão; a chave do canvas vem do time", () => {
    const tm = team("T", "t1", [], { origin: "mission", missionId: "m1", boardKey: "main|/p#m:m1" });
    const [c] = selectConversations(src({ tabs: [tab("t1")], teams: [tm] }));
    expect(c).toMatchObject({ origin: "mission", missionId: "m1", boardKey: "main|/p#m:m1" });
  });

  it("sem time, a aba que é nó do canvas de missão ganha boardKey e missionId", () => {
    const boards = { "main|/p": board(["t9"]), "main|/p#m:m7": board(["t1"]) };
    const by = Object.fromEntries(selectConversations(src({ tabs: [tab("t1"), tab("t9")], boards })).map((c) => [c.ref, c]));
    expect(by.t1).toMatchObject({ boardKey: "main|/p#m:m7", missionId: "m7" });
    expect(by.t9).toMatchObject({ boardKey: "main|/p" });
    expect(by.t9!.missionId).toBeUndefined();
  });

  it("canvas especial (#m:, #c:) vence o da pasta quando a aba está nos dois", () => {
    const boards = { "main|/p": board(["t1"]), "main|/p#c:c1": board(["t1"]) };
    const [c] = selectConversations(src({ tabs: [tab("t1")], boards }));
    expect(c!.boardKey).toBe("main|/p#c:c1");
    expect(c!.missionId).toBeUndefined();
  });

  it("o papel do board vale quando o time não diz", () => {
    const b = { ...board(["t1"]), roles: { t1: "Dev" } };
    const [c] = selectConversations(src({ tabs: [tab("t1")], boards: { "main|/p": b } }));
    expect(c!.role).toBe("Dev");
  });

  it("não inventa UUID: a ref é exatamente a id da aba ou thread:<id>", () => {
    const out = selectConversations(src({ tabs: [tab("abc")], threads: [thread("xyz")] }));
    expect(out.map((c) => c.ref).sort()).toEqual(["abc", "thread:xyz"]);
  });

  it("time cujo membro não existe mais não gera conversa fantasma", () => {
    const tm = team("T", "gone", [member("T", "thread:gone", "x")]);
    expect(selectConversations(src({ teams: [tm] }))).toEqual([]);
  });
});

describe("helpers", () => {
  const tm = team("T", "t1", [member("T", "t2", "R")]);
  const all = selectConversations(src({ tabs: [tab("t1", { openedAt: 1 }), tab("t2", { openedAt: 2 }), tab("t3")], teams: [tm] }));

  it("conversationOf acha pela ref", () => {
    expect(conversationOf(all, "t2")?.role).toBe("R");
    expect(conversationOf(all, "nada")).toBeUndefined();
  });

  it("teamConversations devolve a coroa primeiro e depois os integrantes", () => {
    expect(teamConversations(all, "T").map((c) => c.ref)).toEqual(["t1", "t2"]);
    expect(teamConversations(all, "outro")).toEqual([]);
  });
});
