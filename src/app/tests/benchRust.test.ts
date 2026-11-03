import { describe, expect, it } from "vitest";

import { ESCALA, ESPERADO_MS, FOLGA, TESTES, julgar, lerAmostras, mediana, orcamento } from "../../../scripts/bench-rust.mjs";

const amostra = (pequeno_ms: number, grande_ms: number) => ({ caso: "x", pequeno_ms, grande_ms });

describe("bench de complexidade — driver", () => {
  it("orçamento é ceil(esperado × escala × folga), sem override", () => {
    expect(orcamento(100)).toBe(Math.ceil(100 * ESCALA * FOLGA));
    expect(orcamento(13)).toBe(Math.ceil(13 * ESCALA * FOLGA));
  });

  it("mediana de ímpar e de par", () => {
    expect(mediana([5, 1, 3])).toBe(3);
    expect(mediana([4, 1, 3, 2])).toBe(2.5);
  });

  it("lê a marca BENCH mesmo colada no 'test … ...' do libtest", () => {
    const saida = [
      "running 1 test",
      'test bench::a ... BENCH {"caso":"a/1","pequeno_ms":1.5,"grande_ms":2}',
      'BENCH {"caso":"a/2","pequeno_ms":3,"grande_ms":4}',
      "ok",
    ].join("\n");
    expect(lerAmostras(saida).map((a) => a.caso)).toEqual(["a/1", "a/2"]);
  });

  it("razão acima de 4× falha mesmo dentro do orçamento; abaixo e dentro passa", () => {
    const esperado = { pequeno: 100, grande: 100 };
    expect(julgar("x", [amostra(10, 50), amostra(10, 45), amostra(11, 60)], esperado).falhas).toEqual([
      expect.stringContaining("razão"),
    ]);
    expect(julgar("x", [amostra(90, 100), amostra(95, 110), amostra(100, 120)], esperado).falhas).toEqual([]);
  });

  it("estourar o orçamento falha, e caso sem esperado calibrado também", () => {
    const r = julgar("x", [amostra(1000, 1000)], { pequeno: 100, grande: 100 });
    expect(r.falhas).toHaveLength(2);
    expect(julgar("x", [amostra(1, 1)], undefined).falhas).toEqual([expect.stringContaining("calibrado")]);
  });

  it("todo caso impresso pelos testes tem valor esperado", () => {
    expect(Object.values(TESTES).flat().sort()).toEqual(Object.keys(ESPERADO_MS).sort());
  });
});
