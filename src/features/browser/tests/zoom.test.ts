import { describe, expect, it } from "vitest";

import { clampZoom, stageSize, stepZoom, zoomLabel } from "../zoom";

describe("zoom da página", () => {
  it("sobe e desce pelos passos de um navegador", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.5, 1)).toBe(1.75);
    expect(stepZoom(0.5, -1)).toBe(0.33);
  });

  it("não passa dos limites", () => {
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.25, -1)).toBe(0.25);
    expect(clampZoom(9)).toBe(3);
    expect(clampZoom(0)).toBe(0.25);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("um valor entre dois passos vai ao vizinho na direção pedida", () => {
    expect(stepZoom(1.2, 1)).toBe(1.25);
    expect(stepZoom(1.2, -1)).toBe(1.1);
  });

  it("a área do iframe compensa a escala: preenche 100% depois de escalada", () => {
    expect(stageSize(1)).toEqual({ width: "100%", height: "100%" });
    expect(stageSize(2)).toEqual({ width: "50%", height: "50%" });
    expect(stageSize(0.5)).toEqual({ width: "200%", height: "200%" });
  });

  it("escreve a porcentagem", () => {
    expect(zoomLabel(1.25)).toBe("125%");
    expect(zoomLabel(0.33)).toBe("33%");
  });
});
