import { describe, expect, it } from "vitest";

import { isSafeReleaseTag } from "../releaseTag";

describe("isSafeReleaseTag", () => {
  it("bloqueia barra e barra invertida", () => {
    expect(isSafeReleaseTag("v1.0.0")).toBe(true);
    expect(isSafeReleaseTag("v1/0")).toBe(false);
    expect(isSafeReleaseTag("v1\\0")).toBe(false);
    expect(isSafeReleaseTag("v1..2")).toBe(false);
  });
});
