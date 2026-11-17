import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";

import { dateLocale, formatNumber, numberLocale } from "../dateLocale";

describe("dateLocale / numberLocale", () => {
  beforeEach(async () => {
    if (!i18n.isInitialized) {
      await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: {} } } });
    }
  });

  it("números seguem o idioma do app, não o de data por acidente", async () => {
    await i18n.changeLanguage("pt-BR");
    expect(numberLocale()).toBe("pt-BR");
    expect(dateLocale()).toBe("pt-BR");
    expect(formatNumber(1234)).toBe((1234).toLocaleString("pt-BR"));

    await i18n.changeLanguage("en");
    expect(numberLocale()).toBe("en-US");
    expect(formatNumber(1234)).toBe((1234).toLocaleString("en-US"));
  });
});
