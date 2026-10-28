import { describe, expect, it } from "vitest";

import { scenario } from "../../../../scripts/bench-fixture/gen/scenario.js";
import { TEST_TASKS } from "../../../../scripts/bench/tasks-teste";

describe("conjunto de TESTE do protocolo J2", () => {
  it("são 100 tarefas distintas, geradas, fora das levas v1/v2", () => {
    expect(TEST_TASKS).toHaveLength(100);
    expect(new Set(TEST_TASKS.map((t) => t.id)).size).toBe(100);
    for (const task of TEST_TASKS) {
      expect(task.set).toBe("teste");
      expect(task.url.startsWith("/gen/loja.html?f=")).toBe(true);
      expect(task.goal.length).toBeGreaterThan(10);
      for (const fill of task.fills ?? []) expect(fill).toMatch(/^[^=]+=.+$/);
    }
  });

  it("a mesma (família, semente) dá sempre a mesma variante; sementes diferentes variam", () => {
    expect(scenario("adicionar", 3)).toEqual(scenario("adicionar", 3));
    const goals = new Set(Array.from({ length: 20 }, (_, i) => scenario("adicionar", i + 1).goal));
    expect(goals.size).toBeGreaterThan(5);
    const langs = new Set(Array.from({ length: 20 }, (_, i) => scenario("busca", i + 1).lang));
    expect(langs.size).toBeGreaterThan(1);
  });
});
