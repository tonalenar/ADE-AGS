import { describe, expect, it } from "vitest";

import { parseFixRoundsInput } from "../fixRoundsValue";

describe("parseFixRoundsInput", () => {
  it("campo vazio não vira 0", () => {
    expect(parseFixRoundsInput("")).toBeNull();
    expect(parseFixRoundsInput("   ")).toBeNull();
  });

  it("aceita inteiro de 0 a 20", () => {
    expect(parseFixRoundsInput("0")).toBe(0);
    expect(parseFixRoundsInput("20")).toBe(20);
    expect(parseFixRoundsInput("21")).toBeNull();
    expect(parseFixRoundsInput("1.5")).toBeNull();
  });
});
