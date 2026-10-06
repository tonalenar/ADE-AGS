import { describe, expect, it } from "vitest";

import { haloModeFor, powerTier, sparkAt, sparkCount, stageFor } from "../Pet";

describe("fases de poder", () => {
  it("sobe com a quantidade de agentes trabalhando ao mesmo tempo", () => {
    expect([0, 1, 2].map(powerTier)).toEqual([0, 1, 1]);
    expect([3, 4].map(powerTier)).toEqual([2, 2]);
    expect([5, 6].map(powerTier)).toEqual([3, 3]);
    expect([7, 12].map(powerTier)).toEqual([4, 4]);
  });
});

describe("pet", () => {
  it("evoluciona en cuatro etapas, en los niveles que dice la referencia", () => {
    expect([1, 2].map(stageFor)).toEqual([1, 1]);
    expect([3, 4].map(stageFor)).toEqual([2, 2]);
    expect([5, 6].map(stageFor)).toEqual([3, 3]);
    expect([7, 8, 20, 99].map(stageFor)).toEqual([4, 4, 4, 4]);
  });

  it("la etapa nunca baja al subir de nivel", () => {
    let last = 0;
    for (let level = 1; level <= 99; level++) {
      const stage = stageFor(level);
      expect(stage).toBeGreaterThanOrEqual(last);
      last = stage;
    }
  });

  it("las partículas crecen con el nivel, con un tope", () => {
    expect(sparkCount(1)).toBe(0);
    expect(sparkCount(3)).toBe(2);
    expect(sparkCount(8)).toBe(6);
    expect(sparkCount(99)).toBe(10);
    for (let level = 1; level < 60; level++) expect(sparkCount(level + 1)).toBeGreaterThanOrEqual(sparkCount(level));
  });

  it("cada partícula está siempre en el mismo lugar y dentro del lienzo del pet", () => {
    for (let i = 0; i < 10; i++) {
      const a = sparkAt(i);
      expect(sparkAt(i)).toEqual(a);
      expect(a.x).toBeGreaterThanOrEqual(-3);
      expect(a.x).toBeLessThan(19);
      expect(a.y).toBeGreaterThanOrEqual(4);
      expect(a.y).toBeLessThan(13);
      expect(a.duration).toBeGreaterThan(2);
    }
    // No se apilan todas en el mismo punto.
    expect(new Set(Array.from({ length: 10 }, (_, i) => sparkAt(i).x)).size).toBeGreaterThan(5);
  });
});

describe("contorno luminoso (aura)", () => {
  it("segue o estado do mascote", () => {
    expect(haloModeFor("idle", false)).toBe("idle");
    expect(haloModeFor("working", false)).toBe("working");
    expect(haloModeFor("waiting", false)).toBe("waiting");
  });

  it("subir de nível vence qualquer estado enquanto o efeito dura", () => {
    expect(haloModeFor("idle", true)).toBe("levelup");
    expect(haloModeFor("working", true)).toBe("levelup");
  });
});
