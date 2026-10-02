import { describe, expect, it } from "vitest";

import type { Task } from "@/features/runs/types";
import { layoutRows } from "../MissionMap";

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
