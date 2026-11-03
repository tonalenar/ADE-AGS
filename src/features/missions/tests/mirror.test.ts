import { describe, expect, it } from "vitest";

import type { TeamView } from "@/features/chat/team/ipc";

import { isMissionMirror, mirrorInput, splitMirrors, staleMirrors } from "../mirror";

const team = (over: Partial<TeamView>): TeamView =>
  ({ id: "t", orchestrator: "a", agentId: "claude-code", label: "", cwd: "/r", title: "", createdAt: 0, updatedAt: 0, members: [], headcount: 1, ...over }) as TeamView;

describe("espelho da missão no chat", () => {
  it("separa os times do chat e do canvas dos espelhos de missão", () => {
    const all = [team({ id: "1" }), team({ id: "2", origin: "canvas" }), team({ id: "3", origin: "mission", missionId: "m1" })];
    const { teams, missionTeams } = splitMirrors(all);
    expect(teams.map((t) => t.id)).toEqual(["1", "2"]);
    expect(missionTeams.map((t) => t.id)).toEqual(["3"]);
    expect(isMissionMirror(all[2])).toBe(true);
    expect(isMissionMirror(all[0])).toBe(false);
  });

  it("monta o espelho com o lead como orquestrador e os integrantes abertos", () => {
    const input = mirrorInput({
      mission: { id: "m1", title: "Missão X", cwd: "/r" },
      boardKey: "/r#m:m1",
      lead: { tabId: "tab-lead", agentId: "claude-code", label: "Orquestrador" },
      members: [
        { tabId: "tab-a", agentId: "codex", name: "Backend", roleLabel: "Backend", branch: "team/backend", worktree: "/w/a" },
        { tabId: "tab-lead", agentId: "claude-code", name: "dup", roleLabel: "" },
        { tabId: "tab-b", agentId: "codex", name: "QA", roleLabel: "QA", subagent: true },
      ],
    });
    expect(input?.orchestrator).toBe("tab-lead");
    expect(input?.missionId).toBe("m1");
    expect(input?.title).toBe("Missão X");
    expect(input?.members.map((m) => m.member)).toEqual(["tab-a", "tab-b"]);
    expect(input?.members[0]).toMatchObject({ role: "Backend", branch: "team/backend", worktree: "/w/a", subagent: false });
    expect(input?.members[1].subagent).toBe(true);
  });

  it("sem terminal de orquestrador (Gemini Desktop) não há o que espelhar", () => {
    expect(mirrorInput({ mission: { id: "m1", title: "x", cwd: "/r" }, boardKey: "k", lead: null, members: [] })).toBeNull();
  });

  it("o espelho sai quando a missão fecha, e fica enquanto roda, é rascunho ou some da lista", () => {
    const mirrors = [team({ missionId: "m1" }), team({ missionId: "m2" }), team({ missionId: "m3" }), team({ missionId: "m4" }), team({ missionId: "m5" })];
    const missions = [
      { id: "m1", status: "done" },
      { id: "m2", status: "running" },
      { id: "m3", status: "cancelled" },
      { id: "m4", status: "failed" },
    ];
    expect(staleMirrors(mirrors, missions)).toEqual(["m1", "m3", "m4"]);
    expect(staleMirrors([team({ missionId: "x" })], [])).toEqual([]);
  });
});
