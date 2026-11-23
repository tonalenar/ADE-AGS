import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  addTab: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("i18next", () => ({ default: { t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key } }));
vi.mock("@/features/skills/attachSkills", () => ({ attachSkillsToTab: () => Promise.resolve() }));
vi.mock("@/features/skills/pendingSkillSetup", () => ({ registerPendingSkillSetup: vi.fn() }));
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: {
    subscribe: () => () => undefined,
    getState: () => ({
      workspaceId: "w1",
      activeTabId: "tab-lead",
      addTab: mocks.addTab,
      activateTab: mocks.activateTab,
      closeTab: mocks.closeTab,
    }),
  },
}));
vi.mock("../../store", () => ({
  addSurface: vi.fn(),
  useChatStore: { getState: () => ({ thread: null }) },
}));

import { spawnMember } from "../teamStore";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.addTab.mockReturnValue("tab-new");
  mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "chat_team_provision_begin") {
      return { id: "prov-1", label: String(args?.label ?? "Codex · QA") };
    }
    if (cmd === "pool_pick" && args?.pool === "Trabalho") {
      return "acc-codex-2";
    }
    return undefined;
  });
});

describe("spawnMember em modo TUI", () => {
  it("resolve pool:Nome com resolveAccountChoice e passa accountId para addTab", async () => {
    await spawnMember({
      teamId: "team-1",
      agent: { id: "codex", label: "Codex", command: "codex", available: true } as never,
      role: "qa",
      policy: "read",
      cwd: "/repo",
      worktree: false,
      model: null,
      effort: null,
      account: "pool:Trabalho",
      structured: false,
      subagent: false,
    });

    expect(mocks.invoke).toHaveBeenCalledWith("pool_pick", { agentId: "codex", pool: "Trabalho" });
    expect(mocks.addTab).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-codex-2" }));
  });
});
