import { describe, expect, it } from "vitest";

import { cachedStrokePath, strokePath, strokePathCacheHas } from "../board";

describe("caminho SVG dos traços", () => {
  it("reusa o mesmo caminho enquanto o array de pontos não muda", () => {
    const points = [0, 0, 10, 0, 20, 8, 30, 8];
    const first = cachedStrokePath("s1", points);
    expect(first).toBe(strokePath(points));
    expect(cachedStrokePath("s1", points)).toBe(first);
    const moved = [0, 0, 10, 0, 20, 8, 40, 8];
    expect(cachedStrokePath("s1", moved)).toBe(strokePath(moved));
    expect(cachedStrokePath("s1", moved)).not.toBe(first);
  });

  it("o cache tem teto LRU e larga o traço mais antigo", () => {
    const points = [0, 0, 10, 0, 20, 8, 30, 8];
    cachedStrokePath("old", points);
    expect(strokePathCacheHas("old")).toBe(true);
    for (let i = 0; i < 80; i++) cachedStrokePath(`n${i}`, [0, 0, 10, 0, 20, 8, 30, 8, i]);
    expect(strokePathCacheHas("old")).toBe(false);
  });
});
