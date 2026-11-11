// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/tabs/tabActions", () => ({ requestCloseItem: vi.fn() }));

import { parseShelf } from "../shelf";
import { buildSections, cleanTitle, countStates, initialOf, moveByOne, moveVisibleByOne, NEEDS_ID, PINNED_ID, stepFocus, toggleAllProjects, toggleIn, visibleIds, WORKING_ID, type WorkingShelf } from "../sidebar/sessionsModel";
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

  it("aplica a ordem manual por projeto e põe conversas novas antes das ordenadas", () => {
    const ordered = buildSections(cards, { ...base, orderBySection: { "project:ADE": ["c"] } });
    expect(ordered.find((section) => section.id === "project:ADE")?.items.map((item) => item.tabId)).toEqual(["a", "c"]);
    const moved = buildSections(cards, { ...base, orderBySection: { "project:ADE": ["c", "a"] } });
    expect(moved.find((section) => section.id === "project:ADE")?.items.map((item) => item.tabId)).toEqual(["c", "a"]);
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
  it("move uma conversa no menu e mantém no lugar os ids que estão ocultos", () => {
    expect(moveByOne(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveByOne(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveVisibleByOne(["a", "hidden", "b"], ["a", "b"], "a", 1)).toEqual(["b", "hidden", "a"]);
  });
});

describe("o shelf guarda fixadas, não lidas e grupos recolhidos (aditivo)", () => {
  it("lixo vira vazio; o que já existia continua valendo", () => {
    expect(parseShelf({ snoozed: ["x"], pinned: ["p", 3], unread: "u", collapsed: ["project:A", null] })).toEqual({
      snoozed: ["x"], settled: [], pinned: ["p"], orderBySection: {}, unread: [], collapsed: ["project:A"],
    });
    expect(parseShelf({ orderBySection: { "project:A": ["b", "a", "a", 3], pinned: ["x"] } }).orderBySection).toEqual({ "project:A": ["b", "a"] });
    expect(parseShelf("x")).toEqual({ snoozed: [], settled: [], pinned: [], orderBySection: {}, unread: [], collapsed: [] });
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

describe("a seção Trabalhando e a ordem por último pedido", () => {
  const cards = [card("a", "ADE", 3), card("b", "Outro", 5), card("c", "ADE", 1), card("d", "Outro", 2)];
  const shelf = (over: Partial<WorkingShelf> = {}): WorkingShelf => ({ enabled: true, working: [], needs: [], ...over });
  const idsOfSection = (sections: ReturnType<typeof buildSections>, id: string) =>
    sections.find((s) => s.id === id)?.items.map((c) => c.tabId);

  it("desligada, a lista é a de sempre: nenhuma seção extra", () => {
    const sections = buildSections(cards, { ...base, shelf: { enabled: false, working: ["a"], needs: ["b"] } });
    expect(sections.map((s) => s.kind)).toEqual(["project", "project"]);
  });

  it("ligada: quem precisa de você sobe logo abaixo das fixadas, e quem trabalha vai para o fim", () => {
    const sections = buildSections(cards, { ...base, pinned: ["d"], shelf: shelf({ working: ["a"], needs: ["b"] }) });
    expect(sections.map((s) => s.id)).toEqual([PINNED_ID, NEEDS_ID, "project:ADE", WORKING_ID]);
    expect(idsOfSection(sections, NEEDS_ID)).toEqual(["b"]);
    expect(idsOfSection(sections, WORKING_ID)).toEqual(["a"]);
  });

  it("uma conversa fixada que trabalha fica nas fixadas, não na seção Trabalhando", () => {
    const sections = buildSections(cards, { ...base, pinned: ["a"], shelf: shelf({ working: ["a"] }) });
    expect(sections[0]!.id).toBe(PINNED_ID);
    expect(idsOfSection(sections, PINNED_ID)).toEqual(["a"]);
    expect(sections.some((s) => s.id === WORKING_ID)).toBe(false);
  });

  it("quem está nas duas listas aparece só em 'precisam de você'", () => {
    const sections = buildSections(cards, { ...base, shelf: shelf({ working: ["a"], needs: ["a"] }) });
    expect(sections.some((s) => s.id === WORKING_ID)).toBe(false);
    expect(idsOfSection(sections, NEEDS_ID)).toEqual(["a"]);
  });

  it("ligada, a ordem salva à mão não vale: vale o último pedido seu; desligada, a ordem salva vale", () => {
    const saved = { "project:ADE": ["a", "c"] };
    const lastUserAt = { a: 10, c: 50 };
    const off = buildSections(cards, { ...base, orderBySection: saved, lastUserAt });
    expect(idsOfSection(off, "project:ADE")).toEqual(["a", "c"]);
    const on = buildSections(cards, { ...base, orderBySection: saved, lastUserAt, shelf: shelf() });
    expect(idsOfSection(on, "project:ADE")).toEqual(["c", "a"]);
  });

  it("os projetos ordenam pelo último pedido seu, e sem ele pela abertura", () => {
    expect(buildSections(cards, base).map((s) => s.id)).toEqual(["project:Outro", "project:ADE"]);
    const byUser = { a: 90, b: 20, c: 80, d: 10 };
    expect(buildSections(cards, { ...base, lastUserAt: byUser }).map((s) => s.id)).toEqual(["project:ADE", "project:Outro"]);
  });

  it("a seção Trabalhando põe primeiro quem recebeu o último pedido seu", () => {
    const sections = buildSections(cards, { ...base, shelf: shelf({ working: ["a", "b"] }), lastUserAt: { a: 10, b: 40 } });
    expect(idsOfSection(sections, WORKING_ID)).toEqual(["b", "a"]);
  });
});
