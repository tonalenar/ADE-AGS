import { describe, expect, it } from "vitest";

import { COMPOSER_CLEARANCE, composerGutter, listBottomInset } from "../composerLayout";

describe("a margem do composer pela coluna", () => {
  it("coluna estreita (painel direito aberto) tem margem pequena; a larga, a de sempre", () => {
    expect([360, 419].map(composerGutter)).toEqual([12, 12]);
    expect([420, 440, 520, 559].map(composerGutter)).toEqual([16, 16, 16, 16]);
    expect([560, 640, 699].map(composerGutter)).toEqual([24, 24, 24]);
    expect([700, 736, 960, 1400].map(composerGutter)).toEqual([48, 48, 48, 48]);
  });

  it("o cartão nunca fica menor que a coluna menos as margens, e sobra espaço para os controles", () => {
    for (const w of [360, 440, 520, 720]) expect(w - 2 * composerGutter(w)).toBeGreaterThanOrEqual(336);
  });

  it("sem medida (ainda) ou com lixo vale a margem de 16", () => {
    expect(composerGutter(null)).toBe(16);
    expect(composerGutter(0)).toBe(16);
    expect(composerGutter(Number.NaN)).toBe(16);
  });
});

describe("o espaço do fim da lista (o composer flutua por cima)", () => {
  it("é a altura medida do composer mais o vão, para a última mensagem subir acima do cartão", () => {
    expect(listBottomInset(180)).toBe(180 + COMPOSER_CLEARANCE);
    expect(listBottomInset(420)).toBe(420 + COMPOSER_CLEARANCE);
  });
  it("sem medida ou com lixo, só o vão", () => {
    expect(listBottomInset(0)).toBe(COMPOSER_CLEARANCE);
    expect(listBottomInset(Number.NaN)).toBe(COMPOSER_CLEARANCE);
    expect(listBottomInset(-5)).toBe(COMPOSER_CLEARANCE);
  });
});
