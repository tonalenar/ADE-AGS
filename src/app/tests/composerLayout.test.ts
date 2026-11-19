import { describe, expect, it } from "vitest";

import { composerLayout } from "../composerLayout";

describe("layout do compositor de conversa nova", () => {
  it("flutua sobre o canvas, sem esconder o quadro", () => {
    expect(composerLayout("canvas", true)).toBe("floating");
  });

  it("ocupa a área toda nas abas", () => {
    expect(composerLayout("tabs", true)).toBe("full");
  });

  it("ocupa a área toda fora do workspace", () => {
    expect(composerLayout("canvas", false)).toBe("full");
  });
});
