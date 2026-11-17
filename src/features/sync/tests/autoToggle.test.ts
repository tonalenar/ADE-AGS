import { describe, expect, it } from "vitest";

import { persistAutoSync } from "../autoToggle";

describe("A496 auto sync", () => {
  it("reverte o switch se o IPC falhar", async () => {
    let value = false;
    const out = await persistAutoSync(true, (v) => { value = v; }, async () => { throw new Error("nope"); });
    expect(out.ok).toBe(false);
    expect(value).toBe(false);
  });

  it("mantém o valor se gravar", async () => {
    let value = false;
    const out = await persistAutoSync(true, (v) => { value = v; }, async () => {});
    expect(out.ok).toBe(true);
    expect(value).toBe(true);
  });
});
