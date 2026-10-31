// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/tabs/tabActions", () => ({ requestCloseItem: vi.fn() }));

import { parseShelf } from "../shelf";
import { buildSections, cleanTitle, countStates, initialOf, stepFocus, toggleAllProjects, toggleIn, visibleIds } from "../sidebar/sessionsModel";
import type { ConversationCard } from "../chatModel";

const card = (id: string, project: string, openedAt: number, extra: Partial<ConversationCard> = {}): ConversationCard => ({
  tabId: id, title: `Conversa ${id}`, project, cwd: `/p/${project}`, branch: "main", isWorktree: false, agentId: "claude-code", agentLabel: "Claude Code",
  starting: false, active: false, openedAt, ...extra,
});
const base = { query: "", folder: null, pinned: [] as string[], snoozed: [] as string[], nested: new Set<string>(), collapsed: [] as string[] };

describe("as seções da barra de sessões", () => {
  const cards = [card("a", "ADE", 3), card("b", "Outro", 5), card("c", "ADE", 1), card("d", "Outro", 2)];

  it("agrupa por projeto: o projeto com a conversa mais recente primeiro, e dentro dele a mais recente primeiro", () => {
    const sections = buildSections(cards, base);
    expect(sections.map((s) => s.id)).toEqual(["project:Outro", "project:ADE"]);
    expect(sections[0]!.items.map((c) => c.tabId)).toEqual(["b", "d"]);
    expect(sections[1]!.items.map((c) => c.tabId)).toEqual(["a", "c"]);
  });

  it("as fixadas vão para a seção Fixadas, na ordem em que foram fixadas, e saem do projeto", () => {
    const sections = buildSections(cards, { ...base, pinned: ["c", "b"] });
    expect(sections[0]).toMatchObject({ id: "pinned", kind: "pinned" });
    expect(sections[0]!.items.map((c) => c.tabId)).toEqual(["c", "b"]);
    expect(sections.flatMap((s) => s.items).filter((c) => c.tabId === "c")).toHaveLength(1);
  });

  it("busca, filtro por pasta, adiadas e integrantes do time (aninhados) ficam de fora", () => {
    expect(buildSections(cards, { ...base, query: "conversa a" }).flatMap((s) => s.items.map((c) => c.tabId))).toEqual(["a"]);
    expect(buildSections(cards, { ...base, folder: "ADE" }).map((s) => s.id)).toEqual(["project:ADE"]);
    expect(buildSections(cards, { ...base, snoozed: ["a"] }).flatMap((s) => s.items.map((c) => c.tabId))).not.toContain("a");
    expect(buildSections(cards, { ...base, nested: new Set(["d"]) }).flatMap((s) => s.items.map((c) => c.tabId))).not.toContain("d");
  });

  it("uma fixada adiada ou fora do filtro não aparece em Fixadas; seção vazia some", () => {
    const sections = buildSections(cards, { ...base, pinned: ["a"], snoozed: ["a"] });
    expect(sections.find((s) => s.id === "pinned")).toBeUndefined();
  });

  it("seção recolhida continua na lista, marcada, e seus itens não entram na navegação por teclado", () => {
    const sections = buildSections(cards, { ...base, collapsed: ["project:Outro"] });
    expect(sections[0]).toMatchObject({ id: "project:Outro", collapsed: true });
    expect(visibleIds(sections)).toEqual(["a", "c"]);
  });
});

describe("navegação por teclado", () => {
  const ids = ["a", "b", "c"];
  it("↓ e ↑ andam e param nas pontas; sem foco, ↓ vai ao primeiro e ↑ ao último", () => {
    expect(stepFocus(ids, "a", 1)).toBe("b");
    expect(stepFocus(ids, "c", 1)).toBe("c");
    expect(stepFocus(ids, "a", -1)).toBe("a");
    expect(stepFocus(ids, null, 1)).toBe("a");
    expect(stepFocus(ids, null, -1)).toBe("c");
    expect(stepFocus([], "a", 1)).toBeNull();
    expect(stepFocus(ids, "zzz", 1)).toBe("a");
  });
});

describe("renomear e alternar", () => {
  it("o título novo é aparado, sem quebras e com teto; vazio não renomeia", () => {
    expect(cleanTitle("  Meu   título\nnovo ")).toBe("Meu título novo");
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("x".repeat(300))!.length).toBe(120);
  });
  it("toggleIn põe no fim ou tira", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("o shelf guarda fixadas, não lidas e grupos recolhidos (aditivo)", () => {
  it("lixo vira vazio; o que já existia continua valendo", () => {
    expect(parseShelf({ snoozed: ["x"], pinned: ["p", 3], unread: "u", collapsed: ["project:A", null] })).toEqual({
      snoozed: ["x"], settled: [], pinned: ["p"], unread: [], collapsed: ["project:A"],
    });
    expect(parseShelf("x")).toEqual({ snoozed: [], settled: [], pinned: [], unread: [], collapsed: [] });
  });
});

describe("contagem, avatar e expandir/recolher todos", () => {
  const cards = [card("a", "ADE", 3), card("b", "Outro", 5, { starting: true }), card("c", "ADE", 1)];
  it("conta as que rodam e as que ainda iniciam", () => {
    expect(countStates(cards)).toEqual({ running: 2, starting: 1 });
    expect(countStates([])).toEqual({ running: 0, starting: 0 });
  });
  it("a inicial do avatar", () => {
    expect(initialOf(" tonalencar")).toBe("T");
    expect(initialOf("")).toBe("?");
    expect(initialOf(null)).toBe("?");
  });
  it("recolhe todos os projetos; com todos recolhidos, abre todos; Fixadas não é mexida", () => {
    const sections = buildSections(cards, { ...base, pinned: ["a"] });
    expect(sections.map((s) => s.id)).toEqual(["pinned", "project:Outro", "project:ADE"]);
    expect(toggleAllProjects(sections, [])).toEqual(["project:Outro", "project:ADE"]);
    expect(toggleAllProjects(sections, ["project:Outro", "project:ADE"])).toEqual([]);
    expect(toggleAllProjects(sections, ["pinned", "project:Outro"])).toEqual(["pinned", "project:Outro", "project:ADE"]);
  });
});
