import { describe, expect, it } from "vitest";

import { entryForKey, matchTeamShortcut, MORE_ENTRIES, PANEL_ENTRIES, ROW_CHOICES, type Chord } from "@/features/chat/panelMenu";

const ALL = { terminal: true, pr: false };
const key = (k: string, mods: object = {}) => ({ key: k, ...mods });
const chord = (p: Partial<Chord> & { key: string }): Chord => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...p });

describe("o menu Abrir uma superfície", () => {
  it("as teclas são únicas e cada uma abre a sua linha (maiúscula ou minúscula)", () => {
    expect(new Set(PANEL_ENTRIES.map((e) => e.key)).size).toBe(PANEL_ENTRIES.length);
    expect(entryForKey(key("b"), ALL)?.id).toBe("browser");
    expect(entryForKey(key("D"), ALL)?.id).toBe("diff");
    expect(entryForKey(key("o"), ALL)?.id).toBe("team");
    expect(entryForKey(key("i"), ALL)?.id).toBe("ios");
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

describe("a fileira de ícones do painel", () => {
  it("tem Resumo, Terminal, Diff, Navegador, Aparelho e Arquivos; o resto vai para o ⋯", () => {
    expect(ROW_CHOICES).toEqual(["summary", "terminal", "diff", "browser", "ios", "files"]);
    expect(MORE_ENTRIES.map((e) => e.id)).toEqual(["design", "android", "team", "pr"]);
  });
  it("nada some: fileira e ⋯ juntos são todas as linhas do menu, sem repetir", () => {
    const all = [...ROW_CHOICES, ...MORE_ENTRIES.map((e) => e.id)].sort();
    expect(all).toEqual(PANEL_ENTRIES.map((e) => e.id).sort());
  });
});
