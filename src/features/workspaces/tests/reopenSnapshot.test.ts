import { describe, expect, it } from "vitest";

import { consumeSnapshotAfterRestore } from "../reopenSnapshot";

describe("A518 take após restaurar", () => {
  it("não chama take se a restauração falhar", async () => {
    let took = false;
    await expect(consumeSnapshotAfterRestore({
      peek: async () => ({ tabs: [1] }),
      restore: async () => { throw new Error("meio"); },
      take: async () => { took = true; },
    })).rejects.toThrow("meio");
    expect(took).toBe(false);
  });

  it("take só depois do restore", async () => {
    const order: string[] = [];
    await consumeSnapshotAfterRestore({
      peek: async () => { order.push("peek"); return { tabs: [1] }; },
      restore: async () => { order.push("restore"); },
      take: async () => { order.push("take"); },
    });
    expect(order).toEqual(["peek", "restore", "take"]);
  });
});
