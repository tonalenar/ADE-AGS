import { describe, expect, it } from "vitest";
import { formatBytes, reductionPercent } from "../contextMetrics";

describe("contextMetrics", () => {
  it("calcula a redução e nunca devolve negativo", () => {
    expect(reductionPercent(16384, 3120)).toBe(81);
    expect(reductionPercent(0, 10)).toBe(0);
    expect(reductionPercent(100, 150)).toBe(0);
  });
  it("formata bytes", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(3072)).toBe("3.0 KiB");
    expect(formatBytes(-5)).toBe("0 B");
  });
});
