import { describe, expect, it } from "vitest";

import { creep, STAGE_START, UPDATING_CEILING, versionLine } from "../updateProgress";

describe("versionLine", () => {
  it("mostra de → para, com v na frente", () => {
    expect(versionLine("1.0.67", "1.0.70")).toBe("v1.0.67 → v1.0.70");
    expect(versionLine("v1.0.67", "v1.0.70")).toBe("v1.0.67 → v1.0.70");
  });
  it("sem a versão de partida, só a nova; sem nada, vazio", () => {
    expect(versionLine(null, "1.0.70")).toBe("v1.0.70");
    expect(versionLine(null, null)).toBe("");
  });
});

describe("barra por etapas", () => {
  it("as etapas só avançam", () => {
    expect(STAGE_START.closing).toBeLessThan(STAGE_START.updating);
    expect(STAGE_START.updating).toBeLessThan(UPDATING_CEILING);
    expect(STAGE_START.restarting).toBe(100);
  });
  it("a subida lenta sempre anda e nunca passa do teto", () => {
    let p: number = STAGE_START.updating;
    for (let i = 0; i < 400; i++) {
      const next = creep(p);
      expect(next).toBeGreaterThanOrEqual(p);
      expect(next).toBeLessThanOrEqual(UPDATING_CEILING);
      p = next;
    }
    expect(p).toBeGreaterThan(85);
  });
});
