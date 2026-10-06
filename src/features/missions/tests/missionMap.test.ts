import { describe, expect, it } from "vitest";

import type { Task } from "@/features/runs/types";
import { fitMap, layoutMap, layoutRows } from "../MissionMap";

const task = (id: string, role: "lead" | "worker", dependsOn: string[] = []) =>
  ({ id, role, dependsOn } as unknown as Task);

describe("layoutRows", () => {
  it("pone al lead arriba y a cada worker debajo de su dependencia más baja", () => {
    const rows = layoutRows([
      task("lead", "lead"),
      task("api", "worker"),
      task("ui", "worker"),
      task("tests", "worker", ["api", "ui"]),
      task("deploy", "worker", ["tests"]),
    ]);
    expect(rows.get("lead")).toBe(0);
    expect(rows.get("api")).toBe(1);
    expect(rows.get("ui")).toBe(1);
    expect(rows.get("tests")).toBe(2);
    expect(rows.get("deploy")).toBe(3);
  });

  it("una dependencia del lead o inexistente no empuja la fila", () => {
    const rows = layoutRows([task("lead", "lead"), task("a", "worker", ["lead", "fantasma"])]);
    expect(rows.get("a")).toBe(1);
  });

  it("un ciclo no cuelga el layout", () => {
    const rows = layoutRows([task("a", "worker", ["b"]), task("b", "worker", ["a"])]);
    expect(rows.size).toBe(2);
  });
});

describe("layoutMap / fitMap", () => {
  it("coloca cada tarea una vez y el lienzo cubre todas", () => {
    const { placed, width, height } = layoutMap([task("lead", "lead"), task("a", "worker"), task("b", "worker"), task("c", "worker", ["a"])]);
    expect(placed).toHaveLength(4);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + 196).toBeLessThanOrEqual(width);
      expect(p.y + 74).toBeLessThanOrEqual(height);
    }
  });

  it("un mapa grande se reduce para caber; uno chico no se amplía más de 1:1 y queda centrado", () => {
    const big = fitMap(4000, 2000, 800, 288);
    expect(big.zoom).toBeLessThan(1);
    expect(4000 * big.zoom).toBeLessThanOrEqual(800);
    expect(2000 * big.zoom).toBeLessThanOrEqual(288);
    const small = fitMap(200, 100, 800, 288);
    expect(small).toEqual({ zoom: 1, x: 300, y: 94 });
  });
});
