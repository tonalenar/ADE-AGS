import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/tabs/tabActions", () => ({ requestCloseItem: vi.fn() }));

import { buildSections } from "../sidebar/sessionsModel";
import type { ConversationCard } from "../chatModel";

const card = (id: string, project: string, openedAt: number): ConversationCard => ({
  tabId: id, title: `Conversa ${id}`, project, cwd: `/p/${project}`, branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code",
  starting: false, active: false, openedAt,
});
const base = { query: "", folder: null, pinned: [] as string[], snoozed: [] as string[], nested: new Set<string>(), collapsed: [] as string[] };
const cards = [card("a", "ADE", 3), card("b", "Outro", 5), card("c", "Terceiro", 1)];
const orderOf = (sections: ReturnType<typeof buildSections>) => sections.map((s) => s.label);

describe("a barra usa a ordem escolhida para os projetos", () => {
  it("sem ordem informada, o último pedido continua na frente", () => {
    expect(orderOf(buildSections(cards, base))).toEqual(["Outro", "ADE", "Terceiro"]);
  });

  it("criado em: o projeto que apareceu por último fica em cima", () => {
    const projectOrder = { mode: "created" as const, manual: [], created: { "/p/ADE": 100, "/p/Outro": 200, "/p/Terceiro": 300 } };
    expect(orderOf(buildSections(cards, { ...base, projectOrder }))).toEqual(["Terceiro", "Outro", "ADE"]);
  });

  it("manual: a ordem salva vale e um projeto novo entra em cima", () => {
    const projectOrder = { mode: "manual" as const, manual: ["/p/ADE", "/p/Terceiro", "/p/Outro"], created: {} };
    const comNovo = [...cards, card("d", "Novo", 9)];
    expect(orderOf(buildSections(comNovo, { ...base, projectOrder }))).toEqual(["Novo", "ADE", "Terceiro", "Outro"]);
  });
});
