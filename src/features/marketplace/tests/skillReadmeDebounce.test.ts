import { afterEach, describe, expect, it, vi } from "vitest";

import { README_DEBOUNCE_MS, SkillReadmeCache } from "../skillReadme";

describe("SkillReadmeCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("devolve o markdown já baixado sem nova leitura", () => {
    const cache = new SkillReadmeCache();
    cache.set("r", "s", "# Olá");
    expect(cache.get("r", "s")).toBe("# Olá");
    expect(cache.get("r", "outro")).toBeUndefined();
  });

  it("o debounce da prévia é curto o bastante para tecla repetida", () => {
    expect(README_DEBOUNCE_MS).toBeGreaterThanOrEqual(150);
    expect(README_DEBOUNCE_MS).toBeLessThanOrEqual(250);
  });
});
