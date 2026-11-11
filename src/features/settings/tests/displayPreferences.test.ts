import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DISPLAY_PREFS,
  DISPLAY_PREFS_KEY,
  displayAttributes,
  displayCssVars,
  parseDisplayPrefs,
  readDisplayPrefs,
  saveDisplayPrefs,
} from "@/features/settings/displayPreferences";

/** Um armazenamento em memória: o teste roda no ambiente `node`, sem `localStorage` do navegador. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
  };
}

describe("preferências de exibição: leitura tolerante", () => {
  it("sem nada gravado (ou lixo), volta ao padrão", () => {
    expect(parseDisplayPrefs(null)).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs("texto")).toEqual(DEFAULT_DISPLAY_PREFS);
    expect(parseDisplayPrefs([1, 2])).toEqual(DEFAULT_DISPLAY_PREFS);
  });

  it("o contraste e o vidro ficam dentro da faixa e arredondam", () => {
    expect(parseDisplayPrefs({ contrast: 999 }).contrast).toBe(200);
    expect(parseDisplayPrefs({ contrast: -4 }).contrast).toBe(50);
    expect(parseDisplayPrefs({ contrast: 120.6 }).contrast).toBe(121);
    expect(parseDisplayPrefs({ contrast: "alto" }).contrast).toBe(100);
    expect(parseDisplayPrefs({ glassOpacity: 10 }).glassOpacity).toBe(40);
    expect(parseDisplayPrefs({ glassOpacity: Number.NaN }).glassOpacity).toBe(80);
  });

  it("valores de escolha que não existem caem no padrão", () => {
    const prefs = parseDisplayPrefs({ effortDisplay: "grande", environmentIdentification: "sempre", timeFormat: "12h" });
    expect(prefs.effortDisplay).toBe("label");
    expect(prefs.environmentIdentification).toBe("auto");
    expect(prefs.timeFormat).toBe("locale");
  });

  it("a suavização liga por padrão; só o `false` explícito a desliga", () => {
    expect(parseDisplayPrefs({}).fontSmoothing).toBe(true);
    expect(parseDisplayPrefs({ fontSmoothing: false }).fontSmoothing).toBe(false);
    expect(parseDisplayPrefs({ fontSmoothing: "não" }).fontSmoothing).toBe(true);
  });

  it("a quebra de linha, o contexto do composer e os valores válidos passam como estão", () => {
    const prefs = parseDisplayPrefs({
      codeWrap: true,
      composerContext: true,
      effortDisplay: "bars",
      environmentIdentification: "none",
      timeFormat: "24-hour",
    });
    expect(prefs).toMatchObject({ codeWrap: true, composerContext: true, effortDisplay: "bars", environmentIdentification: "none", timeFormat: "24-hour" });
  });
});

describe("efeito no CSS", () => {
  it("o padrão não mexe em nada: contraste 100% = base cheia, sem reforço", () => {
    expect(displayCssVars(DEFAULT_DISPLAY_PREFS)).toEqual({
      "--cc-contrast-base": "100%",
      "--cc-contrast-boost": "0%",
      "--cc-glass-alpha": "80%",
    });
  });

  it("abaixo de 100% só esmaece; acima só reforça", () => {
    expect(displayCssVars({ ...DEFAULT_DISPLAY_PREFS, contrast: 60 })).toMatchObject({ "--cc-contrast-base": "60%", "--cc-contrast-boost": "0%" });
    expect(displayCssVars({ ...DEFAULT_DISPLAY_PREFS, contrast: 150 })).toMatchObject({ "--cc-contrast-base": "100%", "--cc-contrast-boost": "50%" });
  });

  it("a suavização, a quebra de linha e o vidro sólido viram atributos do <html>", () => {
    expect(displayAttributes(DEFAULT_DISPLAY_PREFS)).toEqual({
      "data-font-smoothing": "on",
      "data-code-wrap": "off",
      "data-glass-solid": "off",
    });
    expect(displayAttributes({ ...DEFAULT_DISPLAY_PREFS, fontSmoothing: false, codeWrap: true, glassOpacity: 100 })).toEqual({
      "data-font-smoothing": "off",
      "data-code-wrap": "on",
      "data-glass-solid": "on",
    });
  });
});

describe("gravação no armazenamento", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sem nada salvo, lê o padrão", () => {
    expect(readDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
  });

  it("o que se grava volta igual na leitura, com a chave do aparelho", () => {
    const saved = saveDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, contrast: 130, codeWrap: true });
    expect(saved.contrast).toBe(130);
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_KEY) ?? "null")).toMatchObject({ contrast: 130, codeWrap: true });
    expect(readDisplayPrefs()).toMatchObject({ contrast: 130, codeWrap: true });
  });

  it("um valor ilegível no armazenamento não quebra: volta ao padrão", () => {
    localStorage.setItem(DISPLAY_PREFS_KEY, "{não é json");
    expect(readDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
  });
});
