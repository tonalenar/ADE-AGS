import { describe, expect, it } from "vitest";

import { skillsPageBanner } from "../skillsPageBanner";

describe("skillsPageBanner", () => {
  it("mostra o erro do store quando o catch da página é morto", () => {
    expect(skillsPageBanner("falhou listar", null)).toBe("falhou listar");
  });
});
