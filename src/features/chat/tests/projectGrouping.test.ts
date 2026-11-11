// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { ConversationCard } from "../chatModel";
import {
  applyProjectGrouping,
  buildRepoIndex,
  DEFAULT_PROJECT_GROUPING,
  PROJECT_GROUPING_KEY,
  parseProjectGrouping,
  readProjectGrouping,
  saveProjectGrouping,
} from "../sidebar/projectGrouping";
import { buildSections } from "../sidebar/sessionsModel";
import type { RepoGroup, WorkspaceNode } from "@/features/workspaces/workspaceTree";

const card = (tabId: string, project: string, cwd: string, openedAt = 1): ConversationCard => ({
  tabId, title: tabId, project, cwd, branch: null, isWorktree: false, agentId: "codex", agentLabel: "Codex",
  starting: false, active: false, openedAt,
});

const node = (cwd: string, isWorktree = false): WorkspaceNode =>
  ({ key: cwd, cwd, title: cwd.split("/").pop()!, branch: null, isPrimary: !isWorktree, isWorktree, changedCount: 0, agents: [], closed: false, savedAgents: 0 });

const groups: RepoGroup[] = [
  { key: "/r/app", name: "app", isRepo: true, workspaces: [node("/r/app"), node("/r/app-wt/feat-x", true)], agentCount: 2 },
  { key: "/r/solto", name: "solto", isRepo: false, workspaces: [node("/r/solto")], agentCount: 1 },
];

afterEach(() => localStorage.clear());

const sectionOpts = { query: "", folder: null, pinned: [], snoozed: [], nested: new Set<string>(), collapsed: [] };

describe("agrupar projetos por repositório na barra", () => {
  const cards = [
    card("a", "app", "/r/app", 3),
    card("b", "feat-x", "/r/app-wt/feat-x", 2),
    card("c", "solto", "/r/solto", 1),
  ];

  it("separado (o padrão) devolve os cartões como vieram", () => {
    expect(DEFAULT_PROJECT_GROUPING).toBe("separate");
    expect(applyProjectGrouping(cards, "separate", buildRepoIndex(groups))).toBe(cards);
    const labels = buildSections(cards, sectionOpts).map((s) => s.label);
    expect(labels).toEqual(["app", "feat-x", "solto"]);
  });

  it("por repositório, o checkout principal e o worktree viram uma seção com o nome do repositório", () => {
    const grouped = applyProjectGrouping(cards, "repository", buildRepoIndex(groups));
    const sections = buildSections(grouped, sectionOpts);
    expect(sections.map((s) => [s.label, s.items.map((i) => i.tabId)])).toEqual([["app", ["a", "b"]], ["solto", ["c"]]]);
    // A pasta de cada conversa não muda: abrir e criar conversa nova seguem valendo para o checkout dela.
    expect(grouped.find((c) => c.tabId === "b")).toMatchObject({ cwd: "/r/app-wt/feat-x", repoKey: "/r/app" });
    // Fora de repositório fica como estava.
    expect(grouped.find((c) => c.tabId === "c")?.repoKey).toBeUndefined();
  });

  it("a identidade da seção agrupada é a raiz do repositório, mesmo que a primeira conversa seja do worktree", () => {
    const worktreeFirst = [card("b", "feat-x", "/r/app-wt/feat-x", 9), card("a", "app", "/r/app", 1)];
    const grouped = applyProjectGrouping(worktreeFirst, "repository", buildRepoIndex(groups));
    const manual = buildSections(grouped, { ...sectionOpts, projectOrder: { mode: "manual", manual: ["/r/app"], created: {} } });
    expect(manual).toHaveLength(1);
    expect(manual[0]!.items.map((i) => i.tabId)).toEqual(["b", "a"]);
  });

  it("só pastas de repositório entram no índice", () => {
    expect([...buildRepoIndex(groups).keys()].sort()).toEqual(["/r/app", "/r/app-wt/feat-x"]);
  });
});

describe("a preferência de agrupamento", () => {
  it("vale o padrão sem nada gravado ou com lixo", () => {
    expect(readProjectGrouping()).toBe("separate");
    localStorage.setItem(PROJECT_GROUPING_KEY, "tudo junto");
    expect(readProjectGrouping()).toBe("separate");
    expect(parseProjectGrouping(null)).toBe("separate");
  });

  it("grava e lê de volta", () => {
    saveProjectGrouping("repository");
    expect(readProjectGrouping()).toBe("repository");
    expect(localStorage.getItem(PROJECT_GROUPING_KEY)).toBe("repository");
  });
});
