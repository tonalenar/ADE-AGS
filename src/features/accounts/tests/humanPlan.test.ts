import { describe, expect, it } from "vitest";

import { humanPlan } from "../usage";

describe("humanPlan", () => {
  it("usa o nome dos planos conhecidos", () => {
    expect(humanPlan("default_claude_pro")).toBe("Pro");
    expect(humanPlan("default_claude_max_20x")).toBe("Max 20×");
  });
  it("um plano novo vira um nome legível, não o id cru", () => {
    expect(humanPlan("default_claude_ai")).toBe("Claude AI");
    expect(humanPlan("enterprise_plus")).toBe("Enterprise Plus");
  });
  it("sem plano, nada", () => {
    expect(humanPlan(null)).toBeNull();
    expect(humanPlan("")).toBeNull();
  });
});
