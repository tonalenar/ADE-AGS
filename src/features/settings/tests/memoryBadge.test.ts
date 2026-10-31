import { describe, expect, it } from "vitest";

import { badgeText, pendingTotal } from "../memoryBadge";

describe("selo de memória nas Configurações", () => {
  it("soma o workspace e as missões", () => {
    expect(pendingTotal({ workspace: 2, byMission: { a: 3, b: 1 } })).toBe(6);
    expect(pendingTotal({ workspace: 0, byMission: {} })).toBe(0);
  });

  it("some sem pendências e vira 99+ acima de 99", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(150)).toBe("99+");
  });
});
