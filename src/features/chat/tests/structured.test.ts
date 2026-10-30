import { describe, expect, it } from "vitest";

import type { ThreadRow } from "@/features/chat/structured/ipc";
import { applyThreadEvent, EMPTY_LIVE, threadCards, threadIdOf, threadKey } from "@/features/chat/structured/model";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "t1", agentId: "codex", cwd: "/home/eu/app", title: "Arrumar login", model: null, effort: null, access: "ask",
  accountId: null, state: "active", createdAt: 1, updatedAt: 5, ...over,
});

describe("conversa por protocolo: eventos", () => {
  it("o texto chega aos pedaços e some quando o item completo chega", () => {
    let live = applyThreadEvent(EMPTY_LIVE, { type: "delta", threadId: "t1", itemId: "m1", delta: "Ol" });
    live = applyThreadEvent(live, { type: "delta", threadId: "t1", itemId: "m1", delta: "á" });
    expect(live.draft).toEqual({ itemId: "m1", text: "Olá" });
    live = applyThreadEvent(live, { type: "item", threadId: "t1", item: { kind: "assistant", id: "m1", text: "Olá" } });
    expect(live.draft).toBeNull();
    expect(live.items).toHaveLength(1);
  });

  it("um item que já existe é trocado no lugar (a ferramenta que terminou)", () => {
    let live = applyThreadEvent(EMPTY_LIVE, { type: "item", threadId: "t1", item: { kind: "tool", id: "c", status: "running" } });
    live = applyThreadEvent(live, { type: "item", threadId: "t1", item: { kind: "assistant", id: "a", text: "x" } });
    live = applyThreadEvent(live, { type: "item", threadId: "t1", item: { kind: "tool", id: "c", status: "done" } });
    expect(live.items.map((i) => [i.id, i.status])).toEqual([["c", "done"], ["a", undefined]]);
  });

  it("pedidos entram e saem; fechar o agente limpa os pendentes", () => {
    const request = { id: "q", threadId: "t1", kind: "command" as const, itemId: null, title: "ls", detail: "", options: [], state: "pending" as const, createdAt: 1 };
    let live = applyThreadEvent(EMPTY_LIVE, { type: "request", threadId: "t1", request });
    live = applyThreadEvent(live, { type: "request", threadId: "t1", request });
    expect(live.requests).toHaveLength(1);
    expect(applyThreadEvent(live, { type: "requestResolved", threadId: "t1", id: "q" }).requests).toHaveLength(0);
    expect(applyThreadEvent({ ...live, phase: "working" }, { type: "closed", threadId: "t1" })).toMatchObject({ phase: "idle", requests: [] });
  });

  it("começar um turno apaga o erro anterior; terminar apaga o rascunho", () => {
    const working = applyThreadEvent({ ...EMPTY_LIVE, error: "falhou" }, { type: "phase", threadId: "t1", phase: "working" });
    expect(working.error).toBeNull();
    const idle = applyThreadEvent({ ...working, draft: { itemId: "m", text: "meio" } }, { type: "phase", threadId: "t1", phase: "idle" });
    expect(idle.draft).toBeNull();
  });
});

describe("conversa por protocolo: cartões", () => {
  it("só as ativas viram cartão, com a chave própria e o nome da pasta", () => {
    const cards = threadCards([row(), row({ id: "t2", state: "settled" })], [], () => "Codex", "t1");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ tabId: threadKey("t1"), project: "app", agentLabel: "Codex", active: true, branch: null });
    expect(threadIdOf(cards[0]!.tabId)).toBe("t1");
    expect(threadIdOf("aba-qualquer")).toBeNull();
  });

  it("a branch vem do painel quando a pasta está nele", () => {
    const groups = [{ workspaces: [{ cwd: "/home/eu/app", title: "app", branch: "feat/x", isWorktree: true }] }] as unknown as RepoGroup[];
    expect(threadCards([row()], groups, (id) => id, null)[0]).toMatchObject({ branch: "feat/x", isWorktree: true, active: false });
  });
});
