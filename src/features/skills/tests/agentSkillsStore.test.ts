import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  agentSkillsScan: vi.fn(async () => [{ name: "x", path: "/x", description: null }]),
}));

vi.mock("../ipc", () => ipc);

import { AGENT_SKILLS_CACHE_LIMIT, useAgentSkillsStore } from "../agentSkillsStore";

describe("useAgentSkillsStore", () => {
  beforeEach(() => {
    useAgentSkillsStore.setState({ entries: {}, pending: {} });
    ipc.agentSkillsScan.mockClear();
  });

  it("não guarda mais que o teto de entradas", async () => {
    const now = Date.now();
    const entries: Record<string, { skills: []; at: number }> = {};
    for (let i = 0; i < AGENT_SKILLS_CACHE_LIMIT; i++) {
      entries[`claude\u0000/p${i}\u0000`] = { skills: [], at: now + i };
    }
    useAgentSkillsStore.setState({ entries, pending: {} });
    await useAgentSkillsStore.getState().load("/novo", "claude");
    expect(Object.keys(useAgentSkillsStore.getState().entries).length).toBe(AGENT_SKILLS_CACHE_LIMIT);
    expect(useAgentSkillsStore.getState().entries["claude\u0000/p0\u0000"]).toBeUndefined();
  });
});
