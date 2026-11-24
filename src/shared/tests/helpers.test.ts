import { describe, expect, it } from "vitest";
import { clamp } from "@/shared/math";
import { basename, basenameOrSelf } from "@/shared/path";
import { formatBytes, formatCompactTokens, formatKibBytes, formatLocaleTokens } from "@/shared/format";
import { formatRelativeUnit, formatShortAgo, relativeAgeParts } from "@/shared/time";

describe("shared helpers", () => {
  it("clamp mantém o valor no intervalo", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it("basename lida com barras POSIX e Windows", () => {
    expect(basename("/Users/ton/app/")).toBe("app");
    expect(basename("C:\\repo\\src\\main.rs")).toBe("main.rs");
    expect(basename("/")).toBe("");
    expect(basenameOrSelf("/")).toBe("/");
    expect(basenameOrSelf("/a/b")).toBe("b");
  });

  it("formatBytes e formatCompactTokens mantêm contratos", () => {
    expect(formatBytes(0, { zeroAsZeroBytes: true })).toBe("0 B");
    expect(formatBytes(1536, { zeroAsZeroBytes: true })).toBe("1.5 KB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(1536, { units: ["B", "kB", "MB"], alwaysOneDecimal: true })).toBe("1.5 kB");
    expect(formatKibBytes(812)).toBe("812 B");
    expect(formatKibBytes(3072)).toBe("3.0 KiB");
    expect(formatCompactTokens(840)).toBe("840");
    expect(formatCompactTokens(1500)).toBe("1.5k");
    expect(formatCompactTokens(124_000)).toBe("124k");
    expect(formatCompactTokens(1_200_000)).toBe("1.2M");
    expect(formatLocaleTokens(1200, "en")).toMatch(/1\.2K/i);
  });

  it("helpers de tempo relativo calculam unidades corretamente", () => {
    expect(relativeAgeParts(950, 1000)).toMatchObject({ value: 50, unit: "s" });
    expect(relativeAgeParts(700, 1000)).toMatchObject({ value: 5, unit: "m" });
    expect(formatShortAgo(null, 1000)).toBe("");
    expect(formatShortAgo(950, 1000)).toBe("50s");
    expect(formatShortAgo(1000 - 7200, 1000)).toBe("2h");
    expect(formatRelativeUnit(700, "en", 1000)).toMatch(/5/);
  });
});
