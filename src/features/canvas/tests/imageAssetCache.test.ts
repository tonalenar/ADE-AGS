import { describe, expect, it } from "vitest";

import { acquireImageAsset, peekImageAsset, releaseImageAsset } from "../ExtraNodes";

describe("cache de imagens do canvas", () => {
  it("duas imagens do mesmo asset só largam o cache na última referência", () => {
    acquireImageAsset("a.png", "data:1");
    acquireImageAsset("a.png", "data:1");
    expect(peekImageAsset("a.png")).toBe("data:1");
    expect(releaseImageAsset("a.png")).toBe("data:1");
    expect(peekImageAsset("a.png")).toBe("data:1");
    expect(releaseImageAsset("a.png")).toBeUndefined();
    expect(peekImageAsset("a.png")).toBeUndefined();
  });
});
