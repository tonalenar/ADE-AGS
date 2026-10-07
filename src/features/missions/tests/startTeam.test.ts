import { beforeEach, expect, it, vi } from "vitest";
import type { Mission } from "../types";
import type { Squad } from "@/features/squads/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), addTab: vi.fn(), send: vi.fn(), board: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/accounts/store", () => ({ useAccountsStore: { getState: () => ({ accounts: [] }) } }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: { getState: () => ({
  addTab: mocks.addTab, activateTab: vi.fn(), detectedAgents: [{ id: "codex", command: "codex", available: true }],
}) } }));
vi.mock("@/features/canvas/store", () => ({ canvasActions: { buildMissionTeam: mocks.board }, missionBoardKey: () => "mission-board", setWorkMode: vi.fn() }));
vi.mock("@/features/terminal/terminalRegistry", () => ({ sendWhenReady: mocks.send }));
vi.mock("../autonomy", () => ({ getAutonomy: () => "safe", withAutonomy: (_id: string, command: string) => command }));
vi.mock("../turns", () => ({ missionTurns: { start: vi.fn() } }));

import { startMissionInTerminals } from "../terminals";

const mission = { id: "m", title: "Mission", objective: "Build", cwd: "C:/clone", leadAgentId: "codex", autoAccount: true } as Mission;
const squad = { lead: { agentId: "codex", autoAccount: true }, members: [{ roleId: "backend", agentId: "codex", autoAccount: true }] } as Squad;
const workspace = (name: string, path: string) => ({ name, cwd: path, root: path, branch: `cc/${name}`, cargoTargetDir: `${path}/src-tauri/target`, prelaunch: `set target=${path}`, environment: `ENV ${path}` });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.addTab.mockReturnValueOnce("lead").mockReturnValueOnce("member");
});

it("prepares isolation before starting, launches each pane in its own cwd and includes known context", async () => {
  mocks.invoke.mockResolvedValueOnce({ workspaces: [workspace("Orquestrador", "C:/wt/lead"), workspace("Backend", "C:/wt/backend")], precheck: "KNOWN PATHS", memory: "- [projeto] APPROVED MEMORY: x" }).mockResolvedValueOnce({}).mockResolvedValue(undefined);
  await startMissionInTerminals(mission, squad, [{ id: "backend", label: "Backend", description: "API", instructions: "Build API" }]);
  expect(mocks.invoke.mock.calls[0]).toEqual(["mission_prepare_team", { missionId: "m", members: ["Orquestrador", "Backend"] }]);
  expect(mocks.invoke.mock.calls[1][0]).toBe("mission_start_terminals");
  expect(mocks.addTab.mock.calls[0][0]).toMatchObject({ cwd: "C:/wt/lead", prelaunch: [{ command: "set target=C:/wt/lead" }] });
  expect(mocks.addTab.mock.calls[1][0]).toMatchObject({ cwd: "C:/wt/backend", prelaunch: [{ command: "set target=C:/wt/backend" }] });
  for (const [, prompt] of mocks.send.mock.calls) {
    expect(prompt).toContain("KNOWN PATHS"); expect(prompt).toContain("APPROVED MEMORY");
  }
  expect(mocks.board).toHaveBeenCalledWith("mission-board", "lead", [{ tabId: "member", roleId: "Backend" }]);
});

it("does not mark running or open terminals when preparation fails", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("git unavailable"));
  await expect(startMissionInTerminals(mission, squad, [])).rejects.toThrow("git unavailable");
  expect(mocks.addTab).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
