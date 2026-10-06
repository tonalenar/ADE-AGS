import { describe, expect, it } from "vitest";

import { CONFETTI_COLORS, confettiAt, isLevelUp } from "../levelUpFx";

describe("isLevelUp", () => {
  it("só comemora a subida de exatamente um nível", () => {
    expect(isLevelUp(3, 4)).toBe(true);
    expect(isLevelUp(4, 4)).toBe(false);
    expect(isLevelUp(5, 4)).toBe(false);
  });

  it("o salto do nível inicial para o real, ao abrir o app, não é subida", () => {
    expect(isLevelUp(1, 7)).toBe(false);
  });
});

describe("confettiAt", () => {
  it("é determinístico: o mesmo confete sai igual a cada render", () => {
    expect(confettiAt(5)).toEqual(confettiAt(5));
  });

  it("usa só as cores do QG e parte do centro para todos os lados", () => {
    const all = Array.from({ length: 14 }, (_, i) => confettiAt(i));
    for (const c of all) expect(CONFETTI_COLORS).toContain(c.color);
    expect(all.some((c) => c.dx > 4)).toBe(true);
    expect(all.some((c) => c.dx < -4)).toBe(true);
    expect(all.some((c) => c.dy < -4)).toBe(true);
    expect(all.some((c) => c.dy > 2)).toBe(true);
  });

  it("os atrasos são curtos, para o confete sair junto", () => {
    for (let i = 0; i < 14; i++) expect(confettiAt(i).delay).toBeLessThan(0.2);
  });
});
