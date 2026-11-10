import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/tabs/tabActions", () => ({ requestCloseItem: vi.fn() }));

import { addSettled, moveConversation, parseShelf, SETTLED_MAX, type SettledConversation, useShelf } from "@/features/chat/shelf";

const entry = (id: string): SettledConversation => ({
  id, title: `t${id}`, cwd: "/p", agentId: "claude-code", agentLabel: "Claude Code", command: "claude", sessionId: "s", accountId: null, settledAt: 1,
});

describe("Adiadas e Concluídas", () => {
  it("lixo vira vazio e entradas sem o essencial saem", () => {
    expect(parseShelf("x")).toEqual({ snoozed: [], settled: [], pinned: [], orderBySection: {}, unread: [], collapsed: [] });
    expect(parseShelf({ snoozed: ["a", 3], settled: [{ id: "x" }, entry("1")] })).toEqual({ snoozed: ["a"], settled: [entry("1")], pinned: [], orderBySection: {}, unread: [], collapsed: [] });
  });

  it("persiste os movimentos ativos por seção e os fixados na própria lista", () => {
    useShelf.setState({ orderBySection: {}, pinned: ["pin-1", "pin-2"] });
    moveConversation("b", "project:A", ["a", "b", "c"], 1);
    moveConversation("pin-1", "pinned", ["pin-1", "pin-2"], 1);
    expect(useShelf.getState().orderBySection["project:A"]).toEqual(["a", "c", "b"]);
    expect(useShelf.getState().pinned).toEqual(["pin-2", "pin-1"]);
  });

  it("concluir põe no topo, sem repetir, com teto", () => {
    let list: SettledConversation[] = [];
    for (let i = 0; i < SETTLED_MAX + 5; i++) list = addSettled(list, entry(String(i)));
    expect(list).toHaveLength(SETTLED_MAX);
    expect(list[0]!.id).toBe(String(SETTLED_MAX + 4));
    expect(addSettled(list, entry(String(SETTLED_MAX + 1)))[0]!.id).toBe(String(SETTLED_MAX + 1));
  });
});
