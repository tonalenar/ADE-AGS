import { beforeEach, describe, expect, it, vi } from "vitest";

// `DESKTOP_OS` é lido ao carregar `shortcuts.ts`: o navegador de macOS é fixado antes dos imports, e o
// contexto de `when` vem de um objeto que o teste controla (sem DOM nem stores).
const ctx = vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", platform: "MacIntel" },
    configurable: true,
  });
  return { values: {} as Record<string, boolean> };
});
vi.mock("../shortcutContext", () => ({ shortcutContext: () => ctx.values }));

import { SHORTCUTS, getShortcuts, matchShortcut } from "../shortcuts";
import { useShortcutPreferences } from "../shortcutPrefs";
import { SHORTCUT_WHEN_CONTEXTS, matchesShortcutWhen, shortcutWhensOverlap, validateShortcutWhen, type ShortcutWhenValues } from "../shortcutWhen";

beforeEach(() => {
  ctx.values = {};
  useShortcutPreferences.getState().resetAll();
});

describe("SnapShot no macOS", () => {
  it("tem um atalho editável, Cmd+Shift+S, que pede a captura ao composer visível", () => {
    const snap = SHORTCUTS.find((s) => s.id === "composer.snapshot");
    expect(snap).toMatchObject({
      key: "s",
      meta: true,
      shift: true,
      action: { kind: "takeSnapshot" },
      display: "Cmd+Shift+S",
      labelKey: "shortcuts.composerSnapshot",
    });
  });

  it("o `when` usa contextos conhecidos e exige chat aberto, botão montado e nenhum foco no terminal", () => {
    const snap = SHORTCUTS.find((s) => s.id === "composer.snapshot")!;
    expect(validateShortcutWhen(snap.when!).ok).toBe(true);
    const base = Object.fromEntries(SHORTCUT_WHEN_CONTEXTS.map((key) => [key, false])) as ShortcutWhenValues;
    const ready = { ...base, chatShell: true, snapshotAvailable: true, isDesktop: true };
    expect(matchesShortcutWhen(snap.when, ready)).toBe(true);
    expect(matchesShortcutWhen(snap.when, { ...ready, snapshotAvailable: false })).toBe(false);
    expect(matchesShortcutWhen(snap.when, { ...ready, terminalFocus: true })).toBe(false);
  });

  it("casa Cmd+Shift+S só quando há botão de captura, e não rouba Ctrl+Shift+S (Habilidades)", () => {
    ctx.values = { chatShell: true, isDesktop: true, snapshotAvailable: true };
    const cmdShiftS = { key: "S", code: "KeyS", ctrlKey: false, shiftKey: true, altKey: false, metaKey: true };
    expect(matchShortcut(cmdShiftS)?.id).toBe("composer.snapshot");
    expect(matchShortcut({ key: "s", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })?.id)
      .toBe("navigation.skills");
    ctx.values.snapshotAvailable = false;
    expect(matchShortcut(cmdShiftS)).toBeNull();
  });

  it("a combinação pode ser trocada nas Configurações e a troca vale para a captura", () => {
    useShortcutPreferences.getState().setBinding("composer.snapshot", { key: "j", ctrl: false, shift: true, alt: false, meta: true });
    const snap = getShortcuts().find((s) => s.id === "composer.snapshot");
    expect(snap?.key).toBe("j");
    expect(snap?.display).toBe("Cmd+Shift+J");
    // `matchShortcut` só descarta o que está explicitamente desabilitado (`enabled === false`).
    expect(snap?.enabled).not.toBe(false);
  });

  it("a tabela do macOS, com o SnapShot, continua sem acordes repetidos com condições sobrepostas", () => {
    const withChord = SHORTCUTS.filter((s) => s.key !== "");
    const sameChord = (a: (typeof withChord)[number], b: (typeof withChord)[number]) => a.key === b.key
      && (a.ctrl ?? true) === (b.ctrl ?? true) && Boolean(a.shift) === Boolean(b.shift)
      && Boolean(a.alt) === Boolean(b.alt) && Boolean(a.meta) === Boolean(b.meta);
    const clashes: string[] = [];
    withChord.forEach((a, i) => withChord.slice(i + 1).forEach((b) => {
      if (sameChord(a, b) && shortcutWhensOverlap(a.when, b.when)) clashes.push(`${a.id} × ${b.id}`);
    }));
    expect(clashes).toEqual([]);
  });
});
