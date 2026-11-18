import { describe, expect, it } from "vitest";

import { setCapped } from "../cappedMap";

describe("setCapped", () => {
  it("expulsa a chave mais antiga ao passar do teto", () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 80; i++) setCapped(map, `k${i}`, i, 80);
    setCapped(map, "novo", 99, 80);
    expect(map.size).toBe(80);
    expect(map.has("k0")).toBe(false);
    expect(map.get("novo")).toBe(99);
  });
});
