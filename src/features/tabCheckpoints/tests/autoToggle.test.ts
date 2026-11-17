import { describe, expect, it } from "vitest";

import { persistCheckpointAuto } from "../autoToggle";

describe("A498 pontos automáticos", () => {
  it("reverte se setSetting falhar", async () => {
    let on = true;
    await persistCheckpointAuto(false, (v) => { on = v; }, async () => { throw new Error("x"); });
    expect(on).toBe(true);
  });
});
