import { describe, expect, it } from "vitest";

import { shouldToastRestoreRead } from "../restoreReadToast";

describe("shouldToastRestoreRead", () => {
  it("no refresh, só a primeira falha avisa", () => {
    expect(shouldToastRestoreRead("refresh", false)).toBe(true);
    expect(shouldToastRestoreRead("refresh", true)).toBe(false);
  });

  it("no restore, avisa mesmo se a leitura já tinha falhado", () => {
    expect(shouldToastRestoreRead("restore", true)).toBe(true);
    expect(shouldToastRestoreRead("restore", false)).toBe(true);
  });
});
