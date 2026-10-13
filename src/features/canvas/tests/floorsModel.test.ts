import { describe, expect, it } from "vitest";

import { canLand, conflictPrompt, defaultStart, filterBranches, floorBadge, landState, parseExcluded, type BranchInfo, type LandPreview } from "../floorsModel";

const preview = (extra: Partial<LandPreview> = {}): LandPreview => ({
  branch: "cc/ajuste", target: "master", ahead: 3, behind: 0, filesChanged: 4, insertions: 20, deletions: 5,
  dirty: false, conflicts: [], conflictsChecked: true, commits: [], ...extra,
});

describe("aterrissar um andar", () => {
  it("só aterrissa o que está pronto: com o que levar, sem sujeira e sem conflito", () => {
    expect(landState(preview())).toBe("ready");
    expect(canLand(preview())).toBe(true);
    expect(landState(preview({ ahead: 0 }))).toBe("nothing");
    expect(landState(preview({ dirty: true }))).toBe("dirty");
    expect(landState(preview({ conflicts: ["a.ts"] }))).toBe("conflict");
    expect(canLand(null)).toBe(false);
    expect(canLand(preview({ conflicts: ["a.ts"] }))).toBe(false);
  });

  it("a sujeira vence o conflito (primeiro se commita)", () => {
    expect(landState(preview({ dirty: true, conflicts: ["a.ts"] }))).toBe("dirty");
  });

  it("o pedido ao agente nomeia o andar, a branch, o alvo e os arquivos, e proíbe force push", () => {
    const text = conflictPrompt("Ajuste", preview({ conflicts: ["src/a.ts", "src/b.ts"] }));
    expect(text).toContain('andar "Ajuste"');
    expect(text).toContain("cc/ajuste");
    expect(text).toContain("git merge master");
    expect(text).toContain("- src/a.ts\n- src/b.ts");
    expect(text).toContain("push --force");
  });

  it("o cartão resume o andar", () => {
    expect(floorBadge(null).kind).toBe("unknown");
    expect(floorBadge(preview()).kind).toBe("ahead");
    expect(floorBadge(preview({ ahead: 0 })).kind).toBe("clean");
    expect(floorBadge(preview({ dirty: true })).kind).toBe("dirty");
    expect(floorBadge(preview({ conflicts: ["x"] })).kind).toBe("conflict");
  });
});

describe("criar um andar", () => {
  const list: BranchInfo[] = [
    { name: "feature/b", current: false, inUse: false },
    { name: "master", current: true, inUse: false },
    { name: "feature/a", current: false, inUse: true },
  ];

  it("a busca casa em qualquer parte do nome e a branch atual vem primeiro", () => {
    expect(filterBranches(list, "").map((b) => b.name)).toEqual(["master", "feature/a", "feature/b"]);
    expect(filterBranches(list, " FEAT ").map((b) => b.name)).toEqual(["feature/a", "feature/b"]);
    expect(filterBranches(list, "zzz")).toEqual([]);
  });

  it("a origem padrão é a branch atual", () => {
    expect(defaultStart(list)).toBe("master");
    expect(defaultStart([{ name: "x", current: false, inUse: false }])).toBe("x");
    expect(defaultStart([])).toBe("HEAD");
  });

  it("as pastas excluídas são relativas, sem repetição e sem sair do projeto", () => {
    expect(parseExcluded("node_modules, target\n./dist/ , node_modules")).toEqual(["node_modules", "target", "dist"]);
    expect(parseExcluded("../fora, /raiz, C:\\x, a/../b, ok\\sub")).toEqual(["ok/sub"]);
    expect(parseExcluded("  ,\n ")).toEqual([]);
  });
});
