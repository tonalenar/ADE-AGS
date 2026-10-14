import { describe, expect, it, vi } from "vitest";

import { bucketDefaultCollapsed, parseCollapsed, useConversationUi } from "../conversationUi";

describe("o que fica recolhido na lista de conversas", () => {
  it("lê só booleanos e ignora lixo", () => {
    expect(parseCollapsed(null)).toEqual({ projects: {}, buckets: {} });
    expect(parseCollapsed("{nao é json")).toEqual({ projects: {}, buckets: {} });
    expect(parseCollapsed("[1]")).toEqual({ projects: {}, buckets: {} });
    expect(parseCollapsed(JSON.stringify({ projects: { a: true, b: "x" }, buckets: { older: false } }))).toEqual({
      projects: { a: true }, buckets: { older: false },
    });
  });

  it("só os mais antigos começam recolhidos", () => {
    expect(bucketDefaultCollapsed("older")).toBe(true);
    expect(bucketDefaultCollapsed("today")).toBe(false);
  });

  it("alterna projeto e grupo, e recolhe ou abre todos os projetos de uma vez", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const ui = useConversationUi.getState();
    ui.toggleProject("p1");
    expect(useConversationUi.getState().projects.p1).toBe(true);
    ui.toggleProject("p1");
    expect(useConversationUi.getState().projects.p1).toBe(false);
    ui.toggleBucket("older");
    expect(useConversationUi.getState().buckets.older).toBe(false);
    ui.toggleBucket("week");
    expect(useConversationUi.getState().buckets.week).toBe(true);
    ui.setAllProjects(["a", "b"], true);
    expect(useConversationUi.getState().projects).toMatchObject({ a: true, b: true });
    ui.setAllProjects(["a", "b"], false);
    expect(useConversationUi.getState().projects).toMatchObject({ a: false, b: false });
  });
});
