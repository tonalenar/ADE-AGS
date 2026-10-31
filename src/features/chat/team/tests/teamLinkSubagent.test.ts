// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ calls: [] as [string, Record<string, unknown> | undefined][] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    backend.calls.push([cmd, args]);
    if (cmd === "chat_team_link") return Promise.resolve({ member: {}, briefing: "", roleLabel: "QA" });
    if (cmd === "chat_team_list") return Promise.resolve([]);
    if (cmd === "chat_team_feed") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import { linkExisting, updateMember } from "../teamStore";

const conv = { key: "tab-2", agentId: "codex", agentLabel: "Codex", title: "Codex", cwd: "/repo" };
const sent = (cmd: string) => backend.calls.find(([c]) => c === cmd)?.[1]?.input as Record<string, unknown> | undefined;

beforeEach(() => { backend.calls = []; });

describe("ligar ao time como subagente", () => {
  it("manda subagent ao ligar uma conversa existente", async () => {
    await linkExisting("t1", conv, "qa", "ask", true);
    expect(sent("chat_team_link")?.subagent).toBe(true);
  });

  it("sem dizer, não manda a marca (o backend mantém o que já havia)", async () => {
    await linkExisting("t1", conv, "qa", "ask");
    expect(sent("chat_team_link")?.subagent).toBeUndefined();
  });

  it("liga e desliga a marca de um integrante já no time", async () => {
    await updateMember("t1", "tab-2", { subagent: false });
    expect(sent("chat_team_update")).toMatchObject({ teamId: "t1", member: "tab-2", subagent: false });
  });
});
