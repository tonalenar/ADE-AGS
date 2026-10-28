import { describe, expect, it } from "vitest";

import { MAX_AREA, MIN_AREA, visualSize } from "../visualSize";

describe("tamanho da foto para o Jev", () => {
  it("o que já está na faixa não muda", () => {
    expect(visualSize(1000, 600)).toEqual({ width: 1000, height: 600 });
    expect(visualSize(994, 685)).toEqual({ width: 994, height: 685 });
  });

  it("a foto pequena do nó do canvas (485×258, recusada pelo Jev) sobe para o meio da faixa, na mesma proporção", () => {
    const size = visualSize(485, 258);
    expect(size.width * size.height).toBeGreaterThan(MIN_AREA);
    expect(size.width * size.height).toBeLessThan(MAX_AREA);
    expect(size.width / size.height).toBeCloseTo(485 / 258, 1);
  });

  it("a foto enorme de uma tela grande desce", () => {
    const size = visualSize(3000, 1800);
    expect(size.width * size.height).toBeLessThan(MAX_AREA);
    expect(size.width / size.height).toBeCloseTo(3000 / 1800, 1);
  });

  it("uma faixa estreita (512×150) também sobe", () => {
    const size = visualSize(512, 150);
    expect(size.width * size.height).toBeGreaterThan(MIN_AREA);
  });

  it("dimensão inválida passa como veio (quem chama já recusa)", () => {
    expect(visualSize(0, 100)).toEqual({ width: 0, height: 100 });
  });
});
