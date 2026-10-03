import { describe, expect, it } from "vitest";

import { modelMeters } from "../antigravityQuota";

describe("modelMeters", () => {
  it("convierte lo que queda en lo usado y ordena por el más gastado", () => {
    const meters = modelMeters([
      { id: "a", name: "A", remainingFraction: 0.9, resetTime: "2026-10-04T00:00:00Z" },
      { id: "b", name: "B", remainingFraction: 0.25 },
    ]);
    expect(meters.map((m) => [m.id, m.percent])).toEqual([["b", 75], ["a", 10]]);
    expect(meters[1].resetsAt).toBe(Date.parse("2026-10-04T00:00:00Z") / 1000);
    expect(meters[0].resetsAt).toBeNull();
  });

  it("omite los modelos que no informan cupo y acota valores fuera de rango", () => {
    const meters = modelMeters([
      { id: "x", name: "X" },
      { id: "y", name: "Y", remainingFraction: 5 },
    ]);
    expect(meters).toHaveLength(1);
    expect(meters[0].percent).toBe(0);
  });
});
