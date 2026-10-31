// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const team = { id: "t1", orchestrator: "tab-1", agentId: "claude-code", label: "Claude Code", cwd: "/repo", title: "x", createdAt: 1, updatedAt: 1, members: [], headcount: 1 };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "chat_team_create" ? team : cmd === "chat_team_list" ? [team] : []),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import { useChatStore } from "../../store";
import { makeOrchestrator } from "../teamStore";

describe("criar o time abre o painel Time (uma vez), por ser pedido da pessoa", () => {
  beforeEach(() => useChatStore.setState({ panel: "ios", surfaces: ["ios"], panelFocus: 0 }));

  it("tornar a conversa orquestradora mostra a aba Time", async () => {
    await makeOrchestrator({ key: "tab-1", agentId: "claude-code", agentLabel: "Claude Code", title: "x", cwd: "/repo" });
    expect(useChatStore.getState().panel).toBe("team");
  });
});
