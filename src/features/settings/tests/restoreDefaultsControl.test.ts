import { describe, expect, it } from "vitest";

import { restoreDefaultsDisabled } from "../restoreDefaultsControl";

describe("restoreDefaultsDisabled", () => {
  it("depois de falhar a leitura, o botão continua utilizável", () => {
    expect(restoreDefaultsDisabled([], true)).toBe(false);
  });

  it("sem mudanças e sem falha, fica desativado", () => {
    expect(restoreDefaultsDisabled([], false)).toBe(true);
  });

  it("enquanto ainda não leu, fica desativado", () => {
    expect(restoreDefaultsDisabled(null, false)).toBe(true);
  });
});
