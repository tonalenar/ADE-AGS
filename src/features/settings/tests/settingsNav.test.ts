import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  NEW_SETTINGS,
  SETTINGS_NAV_GROUPS,
  SETTINGS_PAGE_LABEL_KEYS,
  SETTINGS_SEARCH_ITEMS,
  settingsPageMatches,
} from "@/features/settings/settingsNav";

const pagesInMenu = SETTINGS_NAV_GROUPS.flatMap((g) => g.pages);

describe("menu das Configurações", () => {
  it("cada página aparece no menu uma vez, e o menu tem todas as páginas", () => {
    expect(new Set(pagesInMenu).size).toBe(pagesInMenu.length);
    expect([...pagesInMenu].sort()).toEqual(Object.keys(SETTINGS_PAGE_LABEL_KEYS).sort());
  });

  it("os títulos dos grupos vêm das chaves do menu (nada de texto solto)", () => {
    const headings = SETTINGS_NAV_GROUPS.map((g) => g.heading).filter((h): h is string => h !== null);
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) expect(heading.startsWith("settings.nav.")).toBe(true);
  });

  it("o selo Novo só marca páginas do menu", () => {
    for (const page of NEW_SETTINGS) expect(pagesInMenu).toContain(page);
  });

  it("o grupo ADE guarda o que não tem par no T3 (memória, decisões, CLI…)", () => {
    const ade = SETTINGS_NAV_GROUPS.find((g) => g.heading === "settings.nav.ade");
    expect(ade?.pages).toEqual(expect.arrayContaining(["memory", "decisions", "orchestrator", "cli"]));
  });
});

describe("ajustes da busca", () => {
  it("cada ajuste tem id único e aponta a uma página do menu", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of SETTINGS_SEARCH_ITEMS) expect(pagesInMenu).toContain(item.page);
  });

  it("um bloco (âncora) pertence a uma página só", () => {
    const pageOfAnchor = new Map<string, string>();
    for (const item of SETTINGS_SEARCH_ITEMS) {
      const known = pageOfAnchor.get(item.anchor);
      if (known !== undefined) expect(known).toBe(item.page);
      pageOfAnchor.set(item.anchor, item.page);
    }
  });

  it("toda âncora usada pela busca existe em SettingsPages.tsx (senão o salto cai no vazio)", () => {
    const source = readFileSync(fileURLToPath(new URL("../SettingsPages.tsx", import.meta.url)), "utf8");
    const declared = new Set<string>();
    for (const match of source.matchAll(/SettingsAnchor id="([^"]+)"/g)) declared.add(match[1]);
    for (const match of source.matchAll(/ReadOnlyCard anchor="([^"]+)"/g)) declared.add(match[1]);
    const used = new Set(SETTINGS_SEARCH_ITEMS.map((item) => item.anchor));
    const missing = [...used].filter((anchor) => !declared.has(anchor));
    expect(missing).toEqual([]);
  });

  it("a aba de um ajuste existe na página dele", () => {
    const tabsPerPage: Record<string, string[]> = {
      accounts: ["provedores", "contas", "tuis", "acp"],
      orchestrator: ["orquestrador", "roteamento", "prelaunch"],
    };
    for (const item of SETTINGS_SEARCH_ITEMS) {
      if (item.tab === undefined) continue;
      expect(tabsPerPage[item.page]).toContain(item.tab);
    }
  });
});

describe("busca de página", () => {
  // O `t` de teste: devolve o texto de cada chave usada aqui.
  const texts: Record<string, string> = {
    "settings.browser": "Navegador",
    "settings.devices": "Dispositivos",
  };
  const t = (key: string) => texts[key] ?? key;

  it("sem texto, todas as páginas aparecem", () => {
    expect(settingsPageMatches("browser", "", t)).toBe(true);
    expect(settingsPageMatches("browser", "   ", t)).toBe(true);
  });

  it("acha a página pelo nome, sem caixa nem acento", () => {
    expect(settingsPageMatches("browser", "navegador", t)).toBe(true);
    expect(settingsPageMatches("devices", "DISPOSITIVOS", t)).toBe(true);
    expect(settingsPageMatches("devices", "navegador", t)).toBe(false);
  });
});
