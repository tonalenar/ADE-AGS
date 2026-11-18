import { describe, expect, it } from "vitest";

import { registryRemovalList } from "../removeRegistryState";
import type { SkillSummary } from "@/features/skills/types";

const skill = (id: string, name: string): SkillSummary => ({
  id,
  name,
  description: null,
  version: "1",
  categories: [],
  compatibleAgents: [],
  compatibleVersions: {},
  author: null,
  license: null,
  homepage: null,
  sourcePath: `/skills/${id}`,
  registryId: "reg",
  originSkillId: id,
  registryName: "repo",
  installedAt: 1,
  updatedAt: 1,
  usedBy: [],
});

describe("registryRemovalList", () => {
  it("não trata falha de listagem como 'nenhuma skill'", () => {
    expect(registryRemovalList(null, true)).toEqual({ status: "unknown" });
    expect(registryRemovalList([], true)).toEqual({ status: "unknown" });
  });

  it("distingue carregando, vazio e listado", () => {
    expect(registryRemovalList(null, false)).toEqual({ status: "loading" });
    expect(registryRemovalList([], false)).toEqual({ status: "empty" });
    const rows = [skill("a", "alpha")];
    expect(registryRemovalList(rows, false)).toEqual({ status: "listed", skills: rows });
  });
});
