import { describe, expect, it } from "vitest";

import { DEFAULT_DIFF_PREFS, diffAttributes, parseDiffPrefs } from "@/features/settings/diffPreferences";

describe("preferências de diff: leitura tolerante", () => {
  it("o padrão segue o T3: empilhado, vermelho e verde, trechos recolhidos", () => {
    expect(parseDiffPrefs(null)).toEqual({ layout: "stacked", colors: "red-green", filesCollapsed: true });
    expect(DEFAULT_DIFF_PREFS).toEqual(parseDiffPrefs(undefined));
  });

  it("aceita só os valores conhecidos; o resto cai no padrão", () => {
    expect(parseDiffPrefs({ layout: "lado" }).layout).toBe("stacked");
    expect(parseDiffPrefs({ layout: "split" }).layout).toBe("split");
    expect(parseDiffPrefs({ colors: "roxo" }).colors).toBe("red-green");
    expect(parseDiffPrefs({ colors: "blue-orange" }).colors).toBe("blue-orange");
  });

  it("os trechos recolhidos ligam por padrão; só o `false` explícito os expande", () => {
    expect(parseDiffPrefs({}).filesCollapsed).toBe(true);
    expect(parseDiffPrefs({ filesCollapsed: false }).filesCollapsed).toBe(false);
    expect(parseDiffPrefs({ filesCollapsed: "nao" }).filesCollapsed).toBe(true);
  });

  it("as cores viram o atributo que o CSS lê", () => {
    expect(diffAttributes(DEFAULT_DIFF_PREFS)).toEqual({ "data-diff-colors": "red-green" });
    expect(diffAttributes({ ...DEFAULT_DIFF_PREFS, colors: "blue-orange" })).toEqual({ "data-diff-colors": "blue-orange" });
  });
});
