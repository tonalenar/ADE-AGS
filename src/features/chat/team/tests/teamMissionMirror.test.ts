// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "chat_team_list" ? backend.rows : cmd === "chat_team_feed" ? [] : null),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const row = (over: Record<string, unknown>) => ({
  id: "t", orchestrator: "o", agentId: "claude-code", label: "", cwd: "/r", title: "", createdAt: 1, updatedAt: 1, members: [], headcount: 1, ...over,
});

describe("espelho de missão no store do time", () => {
  beforeEach(() => { vi.resetModules(); });

  it("o espelho fica em missionTeams e nunca em teams (política, canvas e vigia do chat não o veem)", async () => {
    backend.rows = [row({ id: "chat1", origin: "chat" }), row({ id: "m1", origin: "mission", missionId: "mis-1", orchestrator: "lead" }), row({ id: "c1", origin: "canvas" })];
    const store = await import("../teamStore");
    const teams = await store.reloadTeams();
    expect(teams.map((t) => t.id)).toEqual(["chat1", "c1"]);
    expect(store.useTeamStore.getState().teams.map((t) => t.id)).toEqual(["chat1", "c1"]);
    expect(store.useTeamStore.getState().missionTeams.map((t) => t.id)).toEqual(["m1"]);
  });

  it("a sidebar agrupa a missão sob o orquestrador dela", async () => {
    backend.rows = [row({ id: "m1", origin: "mission", missionId: "mis-1", orchestrator: "lead", members: [{ member: "a" }, { member: "b" }] })];
    const store = await import("../teamStore");
    const model = await import("../teamModel");
    await store.reloadTeams();
    const { teams, missionTeams } = store.useTeamStore.getState();
    const grouping = model.sidebarGrouping(["lead", "a", "b", "solta"], [...teams, ...missionTeams]);
    expect(grouping.groups).toEqual({ lead: ["a", "b"] });
    expect([...grouping.nested].sort()).toEqual(["a", "b"]);
  });
});
