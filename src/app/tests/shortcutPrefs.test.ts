// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { getShortcuts, matchShortcut, shortcutForId, shortcutKeyFromEvent, type KeyChord } from "../shortcuts";
import { shortcutBindingKey, useShortcutPreferences, validateShortcutBinding } from "../shortcutPrefs";

function chord(key: string, patch: Partial<KeyChord> = {}): KeyChord {
  return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...patch };
}

afterEach(() => {
  useShortcutPreferences.getState().resetAll();
});

describe("preferências de atalhos", () => {
  it("normaliza teclas e exige um modificador que não conflite com AltGr", () => {
    expect(validateShortcutBinding({ key: "G", ctrl: false, shift: true, alt: false, meta: true })).toEqual({
      key: "g", ctrl: false, shift: true, alt: false, meta: true,
    });
    expect(validateShortcutBinding({ key: " ", ctrl: true })).toMatchObject({ key: "space" });
    expect(validateShortcutBinding({ key: "g", ctrl: false })).toBe("modifier");
    expect(validateShortcutBinding({ key: "g", ctrl: true, alt: true })).toBe("altGr");
  });

  it("recusa teclas reservadas para o sistema e o navegador", () => {
    expect(validateShortcutBinding({ key: "q", meta: true })).toBe("reserved");
    expect(validateShortcutBinding({ key: "w", ctrl: true })).toBe("reserved");
    expect(validateShortcutBinding({ key: "Tab", alt: true })).toBe("reserved");
    expect(validateShortcutBinding({ key: "F4", alt: true })).toBe("reserved");
    expect(validateShortcutBinding({ key: "Space", meta: true })).toBe("reserved");
    expect(validateShortcutBinding({ key: "Escape", ctrl: true, shift: true })).toBe("reserved");
  });

  it("usa a combinação personalizada no listener global e expõe o rótulo atualizado", () => {
    useShortcutPreferences.getState().setBinding("navigation.fleet", {
      key: "g", ctrl: false, shift: true, alt: false, meta: true,
    });

    expect(matchShortcut(chord("g", { shiftKey: true, metaKey: true }))?.action).toEqual({ kind: "goto", path: "/fleet" });
    expect(matchShortcut(chord("f", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutForId("navigation.fleet")).toBe("Meta+Shift+G");
  });

  it("recupera a tecla física em acordes Option+Command do macOS", () => {
    expect(shortcutKeyFromEvent(chord("†", { code: "KeyT", altKey: true, metaKey: true }))).toBe("t");
  });

  it("permite remover um atalho e restaurar os padrões", () => {
    const preferences = useShortcutPreferences.getState();
    preferences.setBinding("palette.primary", null);
    expect(matchShortcut(chord("k", { ctrlKey: true }))).toBeNull();
    expect(shortcutForId("palette.primary")).toBeNull();
    preferences.resetBinding("palette.primary");
    expect(matchShortcut(chord("k", { ctrlKey: true }))?.action).toEqual({ kind: "openPalette" });
  });

  it("ignora uma preferência local que colidir com outra combinação padrão", () => {
    useShortcutPreferences.getState().setBinding("navigation.fleet", {
      key: "h", ctrl: true, shift: true, alt: false, meta: false,
    });
    expect(getShortcuts().find((shortcut) => shortcut.id === "navigation.fleet")?.display).toBe("Ctrl+Shift+F");
    expect(matchShortcut(chord("h", { ctrlKey: true, shiftKey: true }))?.action).toEqual({ kind: "goto", path: "/" });
  });

  it("distingue acordes pela combinação exata de modificadores e tecla", () => {
    const a = validateShortcutBinding({ key: "m", ctrl: true, shift: true });
    const b = validateShortcutBinding({ key: "m", ctrl: true, shift: false });
    expect(typeof a).not.toBe("string");
    expect(typeof b).not.toBe("string");
    if (typeof a !== "string" && typeof b !== "string") expect(shortcutBindingKey(a)).not.toBe(shortcutBindingKey(b));
  });
});
