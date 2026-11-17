import { describe, expect, it } from "vitest";

import { keepFrameMounted } from "../framePolicy";

describe("iframe da prancheta fora da tela", () => {
  it("depois de montar, continua montado mesmo invisível", () => {
    expect(keepFrameMounted(false, false)).toBe(false);
    expect(keepFrameMounted(false, true)).toBe(true);
    expect(keepFrameMounted(true, false)).toBe(true);
    expect(keepFrameMounted(true, true)).toBe(true);
  });
});
