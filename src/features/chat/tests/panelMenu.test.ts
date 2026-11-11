import { describe, expect, it } from "vitest";

import { entryForKey, matchTeamShortcut, MENU_ENTRIES, PANEL_ENTRIES, type Chord } from "@/features/chat/panelMenu";

const ALL = { terminal: true, pr: false };
const key = (k: string, mods: object = {}) => ({ key: k, ...mods });
const chord = (p: Partial<Chord> & { key: string }): Chord => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...p });

describe("o menu Abrir uma superfície", () => {
  it("as teclas são únicas e cada uma abre a sua linha (maiúscula ou minúscula)", () => {
    expect(new Set(PANEL_ENTRIES.map((e) => e.key)).size).toBe(PANEL_ENTRIES.length);
    expect(entryForKey(key("b"), ALL)?.id).toBe("browser");
    expect(entryForKey(key("D"), ALL)?.id).toBe("diff");
    expect(entryForKey(key("o"), ALL)?.id).toBe("team");
    // As letras do T3: M é o Device (iOS por padrão), S o Side chat.
    expect(entryForKey(key("m"), ALL)?.id).toBe("ios");
    expect(entryForKey(key("s"), { ...ALL, side: true })?.id).toBe("side");
    expect(entryForKey(key("e"), ALL)?.id).toBe("design");
  });

  it("linha esmaecida e tecla com modificador não fazem nada", () => {
    expect(entryForKey(key("p"), ALL)).toBeNull();
    expect(entryForKey(key("p"), { terminal: true, pr: true })?.id).toBe("pr");
    expect(entryForKey(key("t"), { terminal: false, pr: false })).toBeNull();
    expect(entryForKey(key("b", { metaKey: true }), ALL)).toBeNull();
    expect(entryForKey(key("b", { ctrlKey: true }), ALL)).toBeNull();
    expect(entryForKey(key("z"), ALL)).toBeNull();
  });
});

describe("o atalho do painel Time", () => {
  it("macOS: ⌥⌘T (a tecla física, pois o ⌥ muda o caractere)", () => {
    expect(matchTeamShortcut(chord({ key: "†", code: "KeyT", altKey: true, metaKey: true }), "macos")).toBe(true);
    expect(matchTeamShortcut(chord({ key: "t", metaKey: true }), "macos")).toBe(false);
    expect(matchTeamShortcut(chord({ key: "o", ctrlKey: true, shiftKey: true }), "macos")).toBe(false);
  });

  it("Windows e Linux: Ctrl+Shift+O, sem Alt (AltGr)", () => {
    expect(matchTeamShortcut(chord({ key: "O", ctrlKey: true, shiftKey: true }), "windows")).toBe(true);
    expect(matchTeamShortcut(chord({ key: "o", ctrlKey: true, shiftKey: true, altKey: true }), "windows")).toBe(false);
    expect(matchTeamShortcut(chord({ key: "o", ctrlKey: true }), "linux")).toBe(false);
  });
});

describe("as linhas do menu do + da coluna", () => {
  it("seguem a ordem e as letras do T3 (B T F D P M S) e as do ADE (E, O, H, G); sem Resumo nem Android (submenu)", () => {
    expect(MENU_ENTRIES.map((e) => `${e.id}:${e.key}`)).toEqual(["browser:b", "terminal:t", "files:f", "diff:d", "pr:p", "ios:m", "side:s", "design:e", "team:o", "renders:h", "snapshots:g"]);
  });
  it("o Android e o Resumo ficam fora do menu mas existem (o Resumo no cabeçalho, o Android no submenu do Device)", () => {
    expect(MENU_ENTRIES.some((e) => e.id === "android" || e.id === "summary")).toBe(false);
    expect(PANEL_ENTRIES.map((e) => e.id)).toEqual(expect.arrayContaining(["summary", "android"]));
    expect(entryForKey(key("a"), ALL)).toBeNull();
    expect(entryForKey(key("r"), ALL)).toBeNull();
  });
});
