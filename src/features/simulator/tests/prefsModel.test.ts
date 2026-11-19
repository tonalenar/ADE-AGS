import { describe, expect, it } from "vitest";

import { SIMULATOR_CATEGORY_IDS } from "../categories";
import { exceptionsForProject, projectKey, withProjectExceptions } from "../prefsModel";

describe("exceções do modo leve por projeto", () => {
  it("usa os IDs de categoria aceitos pelo simslim", () => {
    expect(SIMULATOR_CATEGORY_IDS).toEqual([
      "widgets", "siri", "search", "icloud", "store", "pim", "web", "family", "health", "photos",
      "apps", "messaging", "connectivity", "telemetry", "mdm",
    ]);
  });

  it("normaliza o caminho do projeto sem confundir pastas distintas", () => {
    expect(projectKey("/Users/dev/app/ ")).toBe("/Users/dev/app");
    expect(projectKey("C:\\Users\\dev\\app\\")).toBe("C:/Users/dev/app");
    expect(projectKey("")).toBe("");
  });

  it("usa o padrão global até haver uma escolha para o projeto", () => {
    const global = ["widgets"];
    const projects = { "/Users/dev/app": ["web"] };

    expect(exceptionsForProject(global, projects, "/Users/dev/app")).toEqual(["web"]);
    expect(exceptionsForProject(global, projects, "/Users/dev/other")).toEqual(["widgets"]);
    expect(exceptionsForProject(global, projects, "")).toEqual(["widgets"]);
  });

  it("altera só o projeto atual e altera o padrão quando não há projeto", () => {
    const initial = { global: ["widgets"], projects: { "/Users/dev/app": ["web"] } };

    expect(withProjectExceptions(initial, "/Users/dev/app", ["siri"])).toEqual({
      global: ["widgets"], projects: { "/Users/dev/app": ["siri"] },
    });
    expect(withProjectExceptions(initial, "", ["apps"])).toEqual({
      global: ["apps"], projects: initial.projects,
    });
  });
});
