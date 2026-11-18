import { describe, expect, it, vi } from "vitest";

import { persistToggle } from "../persistToggle";

describe("persistToggle", () => {
  it("reverte o switch se a gravação falhar", async () => {
    const values: boolean[] = [];
    const onError = vi.fn();
    await persistToggle(true, (v) => values.push(v), async () => {
      throw new Error("ipc");
    }, onError);
    expect(values).toEqual([true, false]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("mantém o valor novo se gravar", async () => {
    const values: boolean[] = [];
    await persistToggle(false, (v) => values.push(v), async () => undefined, () => {});
    expect(values).toEqual([false]);
  });
});
