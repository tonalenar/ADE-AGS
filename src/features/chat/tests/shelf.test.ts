import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/tabs/tabActions", () => ({ requestCloseItem: vi.fn() }));

import { addSettled, parseShelf, SETTLED_MAX, type SettledConversation } from "@/features/chat/shelf";

const entry = (id: string): SettledConversation => ({
  id, title: `t${id}`, cwd: "/p", agentId: "claude-code", agentLabel: "Claude Code", command: "claude", sessionId: "s", accountId: null, settledAt: 1,
});

describe("Adiadas e Concluídas", () => {
  it("lixo vira vazio e entradas sem o essencial saem", () => {
    expect(parseShelf("x")).toEqual({ snoozed: [], settled: [] });
    expect(parseShelf({ snoozed: ["a", 3], settled: [{ id: "x" }, entry("1")] })).toEqual({ snoozed: ["a"], settled: [entry("1")] });
  });

  it("concluir põe no topo, sem repetir, com teto", () => {
    let list: SettledConversation[] = [];
    for (let i = 0; i < SETTLED_MAX + 5; i++) list = addSettled(list, entry(String(i)));
    expect(list).toHaveLength(SETTLED_MAX);
    expect(list[0]!.id).toBe(String(SETTLED_MAX + 4));
    expect(addSettled(list, entry(String(SETTLED_MAX + 1)))[0]!.id).toBe(String(SETTLED_MAX + 1));
  });
});
