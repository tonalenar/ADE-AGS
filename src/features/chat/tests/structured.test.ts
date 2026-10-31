import { describe, expect, it } from "vitest";

import type { RequestRow, ThreadRow } from "@/features/chat/structured/ipc";
import {
  applyDeltas, applyThreadEvent, applyThreadMeta, EMPTY_LIVE, isPlanExit, menuAccess, questionOf, STRUCTURED_AGENTS, threadCards, threadIdOf, threadKey,
  togglePlan,
} from "@/features/chat/structured/model";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "t1", agentId: "codex", cwd: "/home/eu/app", title: "Arrumar login", model: null, effort: null, access: "ask",
  accountId: null, state: "active", createdAt: 1, updatedAt: 5, ...over,
});

describe("conversa por protocolo: eventos", () => {
  it("o texto chega aos pedaços e some quando o item completo chega", () => {
    let live = applyThreadEvent(EMPTY_LIVE, { type: "delta", threadId: "t1", itemId: "m1", delta: "Ol" });
    live = applyThreadEvent(live, { type: "delta", threadId: "t1", itemId: "m1", delta: "á" });
    expect(live.drafts).toEqual([{ itemId: "m1", kind: "assistant", text: "Olá" }]);
    live = applyThreadEvent(live, { type: "item", threadId: "t1", item: { kind: "assistant", id: "m1", text: "Olá" } });
    expect(live.drafts).toEqual([]);
    expect(live.items).toHaveLength(1);
  });

  it("os pedaços de um quadro entram de uma vez, por item, e o raciocínio fica separado da resposta", () => {
    const live = applyDeltas(EMPTY_LIVE, [
      { itemId: "r", delta: "Lendo ", kind: "reasoning" },
      { itemId: "m", delta: "Pron" },
      { itemId: "r", delta: "o arquivo", kind: "reasoning" },
      { itemId: "m", delta: "to." },
    ]);
    expect(live.drafts).toEqual([
      { itemId: "r", kind: "reasoning", text: "Lendo o arquivo" },
      { itemId: "m", kind: "assistant", text: "Pronto." },
    ]);
    // Um pedaço atrasado de um item que já chegou inteiro não reabre o rascunho.
    const done = { ...EMPTY_LIVE, items: [{ kind: "assistant" as const, id: "m", text: "Pronto." }] };
    expect(applyDeltas(done, [{ itemId: "m", delta: "x" }])).toBe(done);
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
    const idle = applyThreadEvent({ ...working, drafts: [{ itemId: "m", kind: "assistant", text: "meio" }] }, { type: "phase", threadId: "t1", phase: "idle" });
    expect(idle.drafts).toEqual([]);
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

describe("conversa por protocolo: Claude Code e o Plano", () => {
  const request = (over: Partial<RequestRow> = {}): RequestRow => ({
    id: "q", threadId: "t1", kind: "command", itemId: "toolu_1", title: "", detail: "", options: [], state: "pending", createdAt: 1, ...over,
  });

  it("o Claude Code conversa por protocolo, como o Codex", () => {
    expect(STRUCTURED_AGENTS.has("claude-code")).toBe(true);
    expect(STRUCTURED_AGENTS.has("codex")).toBe(true);
    expect(STRUCTURED_AGENTS.has("gemini-cli")).toBe(false);
  });

  it("o evento da conversa muda só o que veio (título ou acesso)", () => {
    const base = row({ agentId: "claude-code", access: "plan" });
    expect(applyThreadMeta(base, { access: "edits" })).toMatchObject({ access: "edits", title: "Arrumar login" });
    expect(applyThreadMeta(base, { title: "Novo" })).toMatchObject({ access: "plan", title: "Novo" });
    expect(applyThreadMeta(base, { memory: "on" })).toMatchObject({ memory: "on", title: "Arrumar login" });
  });

  it("a saída do Plano se reconhece pela ferramenta; a aprovação comum e a do Codex não", () => {
    expect(isPlanExit(request({ options: { tool: "ExitPlanMode" } }))).toBe(true);
    expect(isPlanExit(request({ options: { tool: "Bash" } }))).toBe(false);
    expect(isPlanExit(request({ options: [] }))).toBe(false);
    expect(isPlanExit(null)).toBe(false);
  });

  it("a pergunta sai das opções só quando o pedido é pergunta", () => {
    const options = [{ id: "Qual banco?", question: "Qual banco?", options: ["SQLite"] }];
    expect(questionOf(request({ kind: "question", options }))).toEqual(options[0]);
    expect(questionOf(request({ kind: "command", options: { tool: "Bash" } }))).toBeNull();
    expect(questionOf(request({ kind: "question", options: { tool: "x" } }))).toBeNull();
  });

  it("desligar o Plano volta a Supervisionado, e o menu mostra esse modo enquanto planeja", () => {
    expect(togglePlan("full")).toBe("plan");
    expect(togglePlan("plan")).toBe("ask");
    expect(menuAccess("plan")).toBe("ask");
    expect(menuAccess("safe")).toBe("safe");
  });
});
