import { describe, expect, it } from "vitest";

import { skipInitialEmptySkillsLoad } from "../marketplaceQuery";

describe("skipInitialEmptySkillsLoad", () => {
  it("não dispara loadSkills vazio na montagem", () => {
    expect(skipInitialEmptySkillsLoad(true, "")).toBe(true);
    expect(skipInitialEmptySkillsLoad(false, "")).toBe(false);
    expect(skipInitialEmptySkillsLoad(true, "quota")).toBe(false);
  });
});
