import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Acessibilidade (a11y) e i18n Completa (pt-BR, en, es)", () => {
  const readLocale = (lang: string): Record<string, string> => {
    const file = resolve(process.cwd(), `src/i18n/locales/${lang}.json`);
    return JSON.parse(readFileSync(file, "utf-8"));
  };

  const pt = readLocale("pt-BR");
  const en = readLocale("en");
  const es = readLocale("es");

  describe("Paridade de Chaves i18n (pt-BR, en, es)", () => {
    it("todas as chaves do pt-BR existem em en e es, e vice-versa (100% de paridade)", () => {
      const ptKeys = Object.keys(pt).sort();
      const enKeys = Object.keys(en).sort();
      const esKeys = Object.keys(es).sort();

      expect(ptKeys.length).toBe(enKeys.length);
      expect(ptKeys.length).toBe(esKeys.length);

      const missingInEn = ptKeys.filter((k) => !(k in en));
      const missingInEs = ptKeys.filter((k) => !(k in es));
      const missingInPt = enKeys.filter((k) => !(k in pt));

      expect(missingInEn).toEqual([]);
      expect(missingInEs).toEqual([]);
      expect(missingInPt).toEqual([]);
    });

    it("nenhum texto de traducao esta vazio", () => {
      for (const [key, val] of Object.entries(pt)) {
        expect(val.trim().length, `pt-BR key "${key}" está vazia`).toBeGreaterThan(0);
      }
      for (const [key, val] of Object.entries(en)) {
        expect(val.trim().length, `en key "${key}" está vazia`).toBeGreaterThan(0);
      }
      for (const [key, val] of Object.entries(es)) {
        expect(val.trim().length, `es key "${key}" está vazia`).toBeGreaterThan(0);
      }
    });

    it("todas as chaves introduzidas na Etapa 20 estao presentes nos 3 idiomas", () => {
      const requiredKeys = [
        "canvas.chat.copy",
        "canvas.chat.copied",
        "canvas.chat.copyCode",
        "canvas.chat.resize.handle",
        "canvas.chat.resize.reset",
        "canvas.chat.resize.maximize",
        "canvas.chat.resize.unmaximize",
        "canvas.chat.pick.open",
        "canvas.chat.pick.title",
        "canvas.chat.pick.hint",
        "canvas.chat.pick.selection",
        "canvas.chat.pick.noPrompt",
        "canvas.chat.pick.empty",
        "canvas.chat.pick.send",
        "canvas.chat.pick.sendSelection",
        "memoryInbox.button",
        "memoryInbox.open",
        "memoryInbox.title",
        "memoryInbox.empty",
        "memoryInbox.loading",
        "memoryInbox.count",
        "memoryInbox.close",
        "memoryInbox.approveAll",
        "memoryInbox.approveSelected",
        "memoryInbox.rejectAll",
        "memoryInbox.rejectSelected",
        "memoryInbox.confirmTitle",
        "memoryInbox.confirmBody",
        "memoryInbox.confirmContradictions",
        "memoryInbox.cancel",
        "memoryInbox.confirmSkip",
        "memoryInbox.confirmAnyway",
        "memoryInbox.confirm",
        "memoryInbox.skipped",
        "memoryInbox.selectMission",
        "memoryInbox.selectItem",
      ];

      for (const k of requiredKeys) {
        expect(k in pt, `Chave ${k} ausente em pt-BR`).toBe(true);
        expect(k in en, `Chave ${k} ausente em en`).toBe(true);
        expect(k in es, `Chave ${k} ausente em es`).toBe(true);
      }
    });
  });

  describe("Suporte a Reduced-Motion e Acessibilidade", () => {
    it("App.css contem regra global para prefers-reduced-motion com desativacao de animacoes e transicoes", () => {
      const css = readFileSync(resolve(process.cwd(), "src/App.css"), "utf-8");
      expect(css).toContain("@media (prefers-reduced-motion: reduce)");
      expect(css).toContain("animation-duration: 1ms !important");
      expect(css).toContain("transition-duration: 1ms !important");
    });
  });
});
