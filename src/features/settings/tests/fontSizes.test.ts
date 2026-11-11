// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FONT_PREFERENCES,
  FONT_SIZE_RANGE,
  fontScaleVars,
  readFontPreferences,
  saveFontPreferences,
} from "@/features/settings/fontPreferences";

const KEY = "cc-font-preferences";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("tamanhos de fonte da interface e do código", () => {
  it("o padrão é o tamanho que o ADE já usa, 14 e 13 px, e a escala vale 1", () => {
    expect(DEFAULT_FONT_PREFERENCES.sizes).toEqual({ interface: 14, code: 13 });
    expect(fontScaleVars(DEFAULT_FONT_PREFERENCES.sizes)).toEqual({
      "--cc-font-scale-ui": "1",
      "--cc-font-scale-code": "1",
    });
  });

  it("a faixa é a do T3 Code: interface de 12 a 20 px, código de 10 a 18 px", () => {
    expect(FONT_SIZE_RANGE.interface).toMatchObject({ min: 12, max: 20 });
    expect(FONT_SIZE_RANGE.code).toMatchObject({ min: 10, max: 18 });
  });

  it("valores fora da faixa são levados para dentro, com arredondamento", () => {
    localStorage.setItem(KEY, JSON.stringify({ sizes: { interface: 99, code: 1.4 } }));
    expect(readFontPreferences().sizes).toEqual({ interface: 20, code: 10 });
  });

  it("valores que não são número voltam ao padrão, e o arredondamento segue a regra", () => {
    localStorage.setItem(KEY, JSON.stringify({ sizes: { interface: "grande", code: 15.6 } }));
    expect(readFontPreferences().sizes).toEqual({ interface: 14, code: 16 });
  });

  it("uma preferência gravada antes dos tamanhos mantém as fontes e ganha o padrão de tamanho", () => {
    localStorage.setItem(KEY, JSON.stringify({ interface: { preset: "inter", family: "" } }));
    expect(readFontPreferences()).toMatchObject({
      interface: { preset: "inter" },
      sizes: { interface: 14, code: 13 },
    });
  });

  it("gravar aplica a escala na janela: o `html` passa a valer o tamanho escolhido sobre o padrão", () => {
    saveFontPreferences({ ...DEFAULT_FONT_PREFERENCES, sizes: { interface: 16, code: 18 } });
    const style = document.documentElement.style;
    expect(Number(style.getPropertyValue("--cc-font-scale-ui"))).toBeCloseTo(16 / 14);
    expect(Number(style.getPropertyValue("--cc-font-scale-code"))).toBeCloseTo(18 / 13);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null").sizes).toEqual({ interface: 16, code: 18 });
  });

  it("'Restaurar padrões' do aparelho volta os tamanhos e a escala para 1", () => {
    saveFontPreferences({ ...DEFAULT_FONT_PREFERENCES, sizes: { interface: 20, code: 10 } });
    saveFontPreferences(DEFAULT_FONT_PREFERENCES);
    expect(readFontPreferences().sizes).toEqual({ interface: 14, code: 13 });
    expect(document.documentElement.style.getPropertyValue("--cc-font-scale-ui")).toBe("1");
    expect(document.documentElement.style.getPropertyValue("--cc-font-scale-code")).toBe("1");
  });
});
