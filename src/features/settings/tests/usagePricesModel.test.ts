import { describe, expect, it } from "vitest";

import { parsePriceInput } from "../usagePricesModel";

describe("preço digitado na página Uso e preços", () => {
  it("aceita vírgula e ponto como separador decimal", () => {
    expect(parsePriceInput("3,5")).toBe(3.5);
    expect(parsePriceInput("3.5")).toBe(3.5);
    expect(parsePriceInput(" 25 ")).toBe(25);
    expect(parsePriceInput("0")).toBe(0);
  });

  it("vazio, negativo, com letra ou com dois separadores não vira número", () => {
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("   ")).toBeNull();
    expect(parsePriceInput("-1")).toBeNull();
    expect(parsePriceInput("1a")).toBeNull();
    expect(parsePriceInput("1,2,3")).toBeNull();
  });
});
