import { describe, expect, it } from "vitest";

import { lookAt } from "../cursorLook";

describe("lookAt", () => {
  it("cursor no centro: olhar reto e sem bracinhos", () => {
    const l = lookAt(0, 0);
    expect(l.x).toBe(0);
    expect(l.armLOn || l.armROn).toBe(false);
  });

  it("os olhos vão para o lado do cursor", () => {
    expect(lookAt(300, 0).x).toBeGreaterThan(0);
    expect(lookAt(-300, 0).x).toBeLessThan(0);
    expect(lookAt(0, 300).y).toBeGreaterThan(0);
    expect(lookAt(0, -300).y).toBeLessThan(0);
  });

  it("o deslocamento é pequeno e limitado, por mais longe que esteja o cursor", () => {
    const l = lookAt(5000, -5000);
    expect(Math.abs(l.x)).toBeLessThanOrEqual(0.7);
    expect(Math.abs(l.y)).toBeLessThanOrEqual(0.5);
  });

  it("o bracinho do lado do cursor sobe quando ele está acima", () => {
    const right = lookAt(200, -200);
    expect(right.armROn).toBe(true);
    expect(right.armLOn).toBe(false);
    const left = lookAt(-200, -200);
    expect(left.armLOn).toBe(true);
    expect(left.armROn).toBe(false);
  });

  it("cursor abaixo não levanta bracinho", () => {
    const l = lookAt(200, 200);
    expect(l.armLOn || l.armROn).toBe(false);
  });
});
