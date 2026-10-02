import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import es from "../locales/es.json";
import ptBR from "../locales/pt-BR.json";
import { LANGUAGE_OPTIONS, persistLocale, resolveLocale } from "../locale";

function shape(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => shape(child, `${prefix}/${key}`)).sort();
  return [`${prefix}:${typeof value}`];
}

describe("Complete PT-BR locale", () => {
  it("keeps identical keys and structure in English, Spanish and Portuguese", () => {
    expect(shape(ptBR)).toEqual(shape(en));
    expect(shape(es)).toEqual(shape(en));
    expect(Object.keys(ptBR).length).toBeGreaterThanOrEqual(1531);
    for (const [key, value] of Object.entries(en)) {
      const translation = ptBR[key as keyof typeof ptBR];
      expect(translation.length, key).toBeGreaterThan(0);
      expect([...translation.matchAll(/\{\{[^}]+\}\}/g)].map((match) => match[0]).sort(), key)
        .toEqual([...value.matchAll(/\{\{[^}]+\}\}/g)].map((match) => match[0]).sort());
    }
  });
  it("resolves Portuguese system locales and defaults ADE AGS to PT-BR", () => {
    for (const system of ["pt", "pt-BR", "pt-PT", "en-US", ""]) expect(resolveLocale(null, system)).toBe("pt-BR");
    expect(resolveLocale("es", "pt-BR")).toBe("es");
    expect(resolveLocale("en", "pt-BR")).toBe("en");
    expect(resolveLocale("pt", "en")).toBe("pt-BR");
  });
  it("offers and persists Português (Brasil)", () => {
    expect(LANGUAGE_OPTIONS[0]).toEqual({ value: "pt-BR", label: "Português (Brasil)" });
    const values = new Map<string, string>();
    persistLocale({ setItem: (key, value) => values.set(key, value) }, "pt-BR");
    expect(resolveLocale(values.get("language") ?? null, "es")).toBe("pt-BR");
  });
  it("registers PT-BR with an English fallback, never Spanish", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("navigator", { language: "pt-BR" });
    try {
      const { default: i18n } = await import("../index");
      expect(i18n.language).toBe("pt-BR");
      expect(i18n.hasResourceBundle("pt-BR", "translation")).toBe(true);
      expect(i18n.options.fallbackLng).toEqual(["en"]);
      expect(i18n.t("squads.form.save")).toBe("Salvar Squad");
      expect(i18n.t("models.effort")).toBe("Esforço");
    } finally { vi.unstubAllGlobals(); }
  });
});
