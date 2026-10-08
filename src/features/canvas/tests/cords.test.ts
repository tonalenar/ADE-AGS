import { describe, expect, it } from "vitest";
import { CORD_COLORS, CORD_MAGNET, CORD_SNAP, cordColor, lightningPoints } from "../cords";

describe("cordColor", () => {
  it("é estável pelo id e sai da paleta", () => {
    expect(cordColor("abc")).toBe(cordColor("abc"));
    expect(CORD_COLORS).toContain(cordColor("abc"));
  });
  it("ids diferentes espalham pela paleta", () => {
    const seen = new Set(Array.from({ length: 40 }, (_, i) => cordColor(`edge-${i}`)));
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("lightningPoints", () => {
  const pts = (s: string) => s.split(" ").map((p) => p.split(",").map(Number));
  it("começa e termina exatamente nas pontas", () => {
    const p = pts(lightningPoints({ x: 0, y: 0 }, { x: 90, y: 0 }, 1, () => 0.9));
    expect(p[0]).toEqual([0, 0]);
    expect(p[p.length - 1]).toEqual([90, 0]);
  });
  it("desvia perpendicularmente e mais com mais força", () => {
    const fraco = pts(lightningPoints({ x: 0, y: 0 }, { x: 90, y: 0 }, 0, () => 1));
    const forte = pts(lightningPoints({ x: 0, y: 0 }, { x: 90, y: 0 }, 1, () => 1));
    const maxY = (p: number[][]) => Math.max(...p.map(([, y]) => Math.abs(y)));
    expect(maxY(forte)).toBeGreaterThan(maxY(fraco));
    expect(maxY(forte)).toBeLessThanOrEqual(9.1); // (6+12)/2
  });
  it("sem aleatoriedade (rand = 0.5) é uma reta", () => {
    const p = pts(lightningPoints({ x: 0, y: 0 }, { x: 0, y: 60 }, 1, () => 0.5));
    expect(p.every(([x]) => x === 0)).toBe(true);
  });
});

describe("raios do ímã", () => {
  it("gruda antes de conectar", () => {
    expect(CORD_SNAP).toBeLessThan(CORD_MAGNET);
  });
});
