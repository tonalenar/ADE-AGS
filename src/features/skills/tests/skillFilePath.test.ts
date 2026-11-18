import { describe, expect, it } from "vitest";

import { nextSkillFilePath } from "../skillFilePath";

describe("nextSkillFilePath", () => {
  it("limpar o campo apaga o caminho anterior", () => {
    expect(nextSkillFilePath("  ")).toBe("");
    expect(nextSkillFilePath("")).toBe("");
  });

  it("caminho preenchido segue recortado", () => {
    expect(nextSkillFilePath("  /tmp/SKILL.md  ")).toBe("/tmp/SKILL.md");
  });
});
