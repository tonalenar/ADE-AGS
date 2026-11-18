import { describe, expect, it } from "vitest";

import { compactTokens } from "../autocompact/model";

describe("compactTokens mostra os múltiplos de milhão sem perder dígitos", () => {
  it("10M sai como 10M, e não como 1M", () => {
    expect(compactTokens(10_000_000)).toBe("10M");
    expect(compactTokens(100_000_000)).toBe("100M");
  });

  it("os valores com fração e o milhão exato continuam como antes", () => {
    expect(compactTokens(1_000_000)).toBe("1M");
    expect(compactTokens(1_250_000)).toBe("1.25M");
    expect(compactTokens(1_500_000)).toBe("1.5M");
    expect(compactTokens(182_400)).toBe("182k");
  });
});
