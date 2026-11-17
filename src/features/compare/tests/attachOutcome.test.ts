import { describe, expect, it } from "vitest";

import { comparisonAfterAttach, shouldUpsertComparison } from "../attachOutcome";

describe("A501 compareAttach", () => {
  it("não grava a comparação sem attach", () => {
    expect(shouldUpsertComparison(null)).toBe(false);
    expect(comparisonAfterAttach({ id: "p" }, null)).toBeNull();
    expect(comparisonAfterAttach({ id: "p" }, { id: "a" })).toEqual({ id: "a" });
  });
});
