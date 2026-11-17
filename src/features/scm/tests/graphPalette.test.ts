import { describe, expect, it } from "vitest";

import { GRAPH_PALETTE } from "../graphPalette";

describe("GRAPH_PALETTE", () => {
  it("tem 8 matizes distintos, só por token, sem hex", () => {
    expect(GRAPH_PALETTE).toHaveLength(8);
    expect(new Set(GRAPH_PALETTE).size).toBe(8);
    for (const color of GRAPH_PALETTE) {
      expect(color.startsWith("var(--color-")).toBe(true);
      expect(color).not.toMatch(/#|[0-9a-fA-F]{6}/);
    }
  });
});
