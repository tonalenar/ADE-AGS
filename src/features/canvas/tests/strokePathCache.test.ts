import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cachedStrokePath, strokePath } from "../board";

const LAYER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../DrawingLayer.tsx");

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

  it("o layer não recalcula strokePath a cada path do SVG", () => {
    const src = readFileSync(LAYER, "utf8");
    expect(src).toContain("cachedStrokePath");
    expect(src).not.toMatch(/strokePath\(/);
  });
});
