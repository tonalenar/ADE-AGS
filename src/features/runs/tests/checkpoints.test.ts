import { describe, expect, it } from "vitest";

import { canRollback, restorable, type Checkpoint } from "../checkpoints";

const cp = (id: string, kind: Checkpoint["kind"], createdAt: number): Checkpoint => ({
  id, runId: "r", taskId: null, kind, dir: "/p", commitSha: "x", headSha: "y", label: "", createdAt,
});

describe("checkpoints (pantalla)", () => {
  it("solo se ofrece volver atrás con la tarea terminada y que no sea el líder", () => {
    expect(canRollback({ status: "done", role: "worker" })).toBe(true);
    expect(canRollback({ status: "failed", role: null })).toBe(true);
    expect(canRollback({ status: "skipped", role: "worker" })).toBe(true);
    expect(canRollback({ status: "running", role: "worker" })).toBe(false);
    expect(canRollback({ status: "pending", role: "worker" })).toBe(false);
    expect(canRollback({ status: "done", role: "lead" })).toBe(false);
  });

  it("restaurar a mano es de las fotos de seguridad y manuales, las más nuevas primero", () => {
    const list = [cp("a", "before", 1), cp("b", "safety", 5), cp("c", "after", 2), cp("d", "manual", 9)];
    expect(restorable(list).map((c) => c.id)).toEqual(["d", "b"]);
    expect(restorable([])).toEqual([]);
  });
});
