import { describe, expect, it } from "vitest";

import { resolveAppearanceMode } from "../appearanceMode";

describe("resolveAppearanceMode", () => {
  it("usa a preferência do sistema somente no modo Sistema", () => {
    expect(resolveAppearanceMode("system", true)).toBe("dark");
    expect(resolveAppearanceMode("system", false)).toBe("light");
    expect(resolveAppearanceMode("dark", false)).toBe("dark");
    expect(resolveAppearanceMode("light", true)).toBe("light");
  });
});
