import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SETTINGS_PAGE_LABEL_KEYS,
  SETTINGS_SEARCH_ITEMS,
  searchSettingsItems,
  type SettingsSearchItem,
  type SettingsSearchResult,
} from "@/features/settings/settingsNav";

// O texto real do catálogo pt-BR: a busca tem de achar pelas palavras que a pessoa vê.
const catalog: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../i18n/locales/pt-BR.json", import.meta.url)), "utf8"),
);
const t = (key: string) => catalog[key] ?? key;
const idsOf = (results: SettingsSearchResult[]) => results.map((r) => r.item.id);

describe("textos da busca", () => {
  it("todo ajuste e toda página têm texto no catálogo pt-BR", () => {
    for (const item of SETTINGS_SEARCH_ITEMS) {
      expect(catalog[item.titleKey], `título de ${item.id}`).toBeTypeOf("string");
      for (const key of item.keywordKeys ?? []) expect(catalog[key], `palavra de ${item.id}`).toBeTypeOf("string");
    }
    for (const key of Object.values(SETTINGS_PAGE_LABEL_KEYS)) expect(catalog[key], key).toBeTypeOf("string");
  });
});

describe("busca de ajustes", () => {
  it("consulta vazia ou só com espaço não acha nada", () => {
    expect(searchSettingsItems("", t)).toEqual([]);
    expect(searchSettingsItems("   ", t)).toEqual([]);
  });

  it("nome igual vem antes do que começa com a palavra, e este antes do que só a contém", () => {
    const results = searchSettingsItems("tema", t);
    expect(results[0].item.id).toBe("appearance.mode");
    expect(idsOf(results)).toContain("appearance.themes");
    expect(idsOf(results).indexOf("appearance.themes")).toBeGreaterThan(0);
  });

  it("ignora caixa e acento", () => {
    expect(idsOf(searchSettingsItems("IDIOMA", t))).toContain("general.language");
    expect(idsOf(searchSettingsItems("aparencia", t))).toEqual(expect.arrayContaining(["appearance.mode", "appearance.fonts"]));
  });

  it("acha pelo nome da página, mesmo quando o nome do ajuste não tem a palavra", () => {
    // "navegador" não está no nome de browser.search nem de browser.import só por ser a página
    expect(idsOf(searchSettingsItems("navegador", t))).toEqual(expect.arrayContaining(["browser.search", "browser.import"]));
  });

  it("cada palavra tem de casar, em qualquer ordem", () => {
    const first = idsOf(searchSettingsItems("modo chat", t));
    expect(first).toEqual(expect.arrayContaining(["chat.open", "chat.width"]));
    expect(first.every((id) => id.startsWith("chat."))).toBe(true);
    expect(idsOf(searchSettingsItems("chat modo", t)).sort()).toEqual([...first].sort());
  });

  it("uma palavra que não existe em lugar nenhum zera o resultado", () => {
    expect(searchSettingsItems("tema zzzz", t)).toEqual([]);
  });

  it("o ajuste de GPU só aparece em Linux", () => {
    expect(idsOf(searchSettingsItems("gpu", t))).not.toContain("appearance.rendering");
    expect(idsOf(searchSettingsItems("gpu", t, { linux: true }))).toContain("appearance.rendering");
  });

  it("a ordem é: nome exato, começa com, contém, e depois os outros campos", () => {
    const items: SettingsSearchItem[] = [
      { id: "contem", page: "general", anchor: "geral", titleKey: "k.contem" },
      { id: "exato", page: "general", anchor: "geral", titleKey: "k.exato" },
      { id: "comeca", page: "general", anchor: "geral", titleKey: "k.comeca" },
    ];
    const dict: Record<string, string> = { "k.exato": "Tema", "k.comeca": "Temas", "k.contem": "Meu tema", "settings.general": "Geral" };
    const tt = (key: string) => dict[key] ?? key;
    expect(idsOf(searchSettingsItems("tema", tt, {}, items))).toEqual(["exato", "comeca", "contem"]);
  });

  it("palavras extras também acham o ajuste, com a posição mais baixa", () => {
    const items: SettingsSearchItem[] = [{ id: "x", page: "general", anchor: "geral", titleKey: "k.titulo", keywordKeys: ["k.palavras"] }];
    const dict: Record<string, string> = { "k.titulo": "Notificações", "k.palavras": "alertas do sistema", "settings.general": "Geral" };
    const tt = (key: string) => dict[key] ?? key;
    const results = searchSettingsItems("alertas", tt, {}, items);
    expect(idsOf(results)).toEqual(["x"]);
    expect(results[0].rank).toBe(1);
  });
});
