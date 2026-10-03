import { describe, expect, it } from "vitest";

import { STRATEGIES, isPoolValue, poolNameOf, poolValue } from "../pools";

describe("pools de cuentas (lado de la pantalla)", () => {
  it("un pool se pide como pool:Nombre y se reconoce sin mayúsculas", () => {
    expect(poolValue("Trabajo")).toBe("pool:Trabajo");
    expect(isPoolValue("pool:Trabajo")).toBe(true);
    expect(isPoolValue("POOL:Trabajo")).toBe(true);
    expect(poolNameOf("pool: Dos palabras ")).toBe("Dos palabras");
  });

  it("un id de cuenta o el valor vacío no son un pool", () => {
    expect(isPoolValue("3f2a9c")).toBe(false);
    expect(isPoolValue("auto")).toBe(false);
    expect(isPoolValue(undefined)).toBe(false);
    expect(isPoolValue("")).toBe(false);
  });

  it("las tres estrategias son las del backend", () => {
    expect(STRATEGIES).toEqual(["least_used", "round_robin", "sticky"]);
  });
});
