import { describe, expect, it } from "vitest";

import { shortcutWhensOverlap } from "../shortcutWhen";
import {
  SHORTCUTS,
  matchShortcut,
  nextTabId,
  resolveGoto,
  shortcutForPath,
  type KeyChord,
} from "../shortcuts";

/** Un acorde con todo apagado, para que cada test encienda solo lo suyo. */
function chord(partial: Partial<KeyChord> & { key: string }): KeyChord {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial };
}

describe("matchShortcut", () => {
  it("reconoce los acordes de la tabla", () => {
    expect(matchShortcut(chord({ key: "M", ctrlKey: true, shiftKey: true }))?.action).toEqual({
      kind: "goto",
      path: "/marketplace",
    });
    expect(matchShortcut(chord({ key: "k", ctrlKey: true }))?.action).toEqual({ kind: "openPalette" });
    expect(matchShortcut(chord({ key: ",", ctrlKey: true }))?.action).toEqual({ kind: "openSettings" });
    expect(matchShortcut(chord({ key: "Tab", ctrlKey: true }))?.action).toEqual({
      kind: "cycleTab",
      delta: 1,
    });
  });

  /// Shift distingue dos acordes que comparten tecla, así que tiene que compararse en los
  /// dos sentidos: exigirlo donde va y rechazarlo donde no.
  it("Shift elige entre ciclar hacia adelante y hacia atrás", () => {
    expect(matchShortcut(chord({ key: "Tab", ctrlKey: true, shiftKey: true }))?.action).toEqual({
      kind: "cycleTab",
      delta: -1,
    });
    expect(matchShortcut(chord({ key: "m", ctrlKey: true }))).toBeNull();
  });

  /// Os controles do readline (Ctrl+E fim de linha, Ctrl+F avançar, Ctrl+H backspace,
  /// Ctrl+M Enter) têm que chegar ao terminal: nenhum deles pode ser um atalho global.
  it("não rouba os Ctrl+letra que o terminal usa", () => {
    for (const key of ["e", "f", "h", "m", "a", "u", "w", "r", "c", "d", "l"]) {
      expect(matchShortcut(chord({ key, ctrlKey: true }))).toBeNull();
    }
  });

  it("sin Ctrl no hay atajo", () => {
    expect(matchShortcut(chord({ key: "m" }))).toBeNull();
  });

  /// AltGr llega como Ctrl+Alt en Windows y Linux: sin este rechazo, escribir un carácter
  /// con AltGr saltaría de sección en medio de una frase.
  it("Ctrl+Alt (AltGr) no dispara nada", () => {
    expect(matchShortcut(chord({ key: "k", ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("Meta no dispara nada (Cmd+M minimiza en macOS)", () => {
    expect(matchShortcut(chord({ key: "k", ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it("la tecla llega en mayúscula cuando hay Shift", () => {
    expect(matchShortcut(chord({ key: "TAB", ctrlKey: true, shiftKey: true }))?.action).toEqual({
      kind: "cycleTab",
      delta: -1,
    });
  });

  it("Ctrl+Shift+Tab en WebKitGTK, donde Shift+Tab llega como tecla desconocida", () => {
    expect(matchShortcut(chord({ key: "Unidentified", code: "Tab", ctrlKey: true, shiftKey: true }))?.action)
      .toEqual({ kind: "cycleTab", delta: -1 });
  });

  it("una tecla que no está en la tabla no matchea", () => {
    // O `z` saiu daqui: Ctrl+Z (⌘+Z no macOS) agora é `thread.undo`, e o handler global o devolve ao terminal.
    expect(matchShortcut(chord({ key: "j", ctrlKey: true }))).toBeNull();
  });

  it("o `when` padrão da tabela vale: Ctrl+F fora da timeline não vira busca (segue para o terminal)", () => {
    expect(matchShortcut(chord({ key: "f", ctrlKey: true }))).toBeNull();
  });
});

describe("la tabla de atajos", () => {
  /// Dos filas con el mismo acorde y condiciones que pueden cumplirse a la vez harían que la segunda fuera
  /// inalcanzable, y el síntoma sería "este atajo no hace nada" sin ninguna pista de por qué. Repetir el acorde
  /// vale cuando los `when` no se solapan (Ctrl+1…9 sirve a la lista, al selector de modelos o a la paleta).
  it("no tiene acordes repetidos con condiciones que se solapan", () => {
    const sameChord = (a: (typeof SHORTCUTS)[number], b: (typeof SHORTCUTS)[number]) => a.key === b.key
      && (a.ctrl ?? true) === (b.ctrl ?? true) && Boolean(a.shift) === Boolean(b.shift)
      && Boolean(a.alt) === Boolean(b.alt) && Boolean(a.meta) === Boolean(b.meta);
    // Sin tecla = acción sin acorde por defecto (solo paleta o Configuración).
    const withChord = SHORTCUTS.filter((s) => s.key !== "");
    const clashes: string[] = [];
    withChord.forEach((a, i) => withChord.slice(i + 1).forEach((b) => {
      if (sameChord(a, b) && shortcutWhensOverlap(a.when, b.when)) clashes.push(`${a.id} × ${b.id}`);
    }));
    expect(clashes).toEqual([]);
  });

  it("los ids son únicos", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("las teclas están en minúscula, que es como se comparan", () => {
    for (const s of SHORTCUTS) expect(s.key).toBe(s.key.toLowerCase());
  });
});

describe("resolveGoto", () => {
  it("lleva a la sección cuando estás en otra parte", () => {
    expect(resolveGoto("/marketplace", "/", true)).toBe("/marketplace");
  });

  it("estando ya en la sección, vuelve a la terminal", () => {
    expect(resolveGoto("/marketplace", "/marketplace", true)).toBe("/workspace");
  });

  it("numa sub-rota da seção (ex.: /skills/<id>) também volta à terminal", () => {
    expect(resolveGoto("/skills", "/skills/abc", true)).toBe("/workspace");
    expect(resolveGoto("/skills", "/skillsx", true)).toBe("/skills");
  });

  /// Sin tabs, `/workspace` rebota a Home solo: el atajo no debe provocar ese parpadeo.
  it("sin tabs abiertas no hace nada en vez de rebotar", () => {
    expect(resolveGoto("/marketplace", "/marketplace", false)).toBeNull();
  });
});

describe("nextTabId", () => {
  const tabs = ["a", "b", "c"];

  it("avanza y retrocede", () => {
    expect(nextTabId(tabs, "a", 1)).toBe("b");
    expect(nextTabId(tabs, "b", -1)).toBe("a");
  });

  it("da la vuelta en los dos extremos", () => {
    expect(nextTabId(tabs, "c", 1)).toBe("a");
    expect(nextTabId(tabs, "a", -1)).toBe("c");
  });

  it("sin tabs no hay nada que activar", () => {
    expect(nextTabId([], "a", 1)).toBeNull();
  });

  it("con una sola tab se queda en ella", () => {
    expect(nextTabId(["a"], "a", 1)).toBe("a");
  });

  /// Puede no haber tab activa (una ventana recién restaurada, por ejemplo): se entra por
  /// la punta que corresponde al sentido, no siempre por la primera.
  it("sin tab activa entra por la punta del sentido", () => {
    expect(nextTabId(tabs, null, 1)).toBe("a");
    expect(nextTabId(tabs, null, -1)).toBe("c");
  });

  it("una tab activa que ya no existe se trata como si no hubiera ninguna", () => {
    expect(nextTabId(tabs, "borrada", 1)).toBe("a");
  });
});

describe("shortcutForPath", () => {
  it("encuentra el acorde de una sección", () => {
    expect(shortcutForPath("/settings")).toBe("Ctrl+,");
    expect(shortcutForPath("/fleet")).toBe("Ctrl+Shift+F");
  });

  it("una ruta sin atajo devuelve null", () => {
    expect(shortcutForPath("/workspaces")).toBeNull();
  });
});

describe("zoom do texto", () => {
  const chord = (key: string, shift = false) => ({ key, ctrlKey: true, shiftKey: shift, altKey: false, metaKey: false });
  it("Ctrl+= e Ctrl++ aumentam, Ctrl+- diminui, Ctrl+0 volta", () => {
    expect(matchShortcut(chord("="))?.action).toEqual({ kind: "textZoom", delta: 1 });
    expect(matchShortcut(chord("+", true))?.action).toEqual({ kind: "textZoom", delta: 1 });
    expect(matchShortcut(chord("+"))?.action).toEqual({ kind: "textZoom", delta: 1 });
    expect(matchShortcut(chord("-"))?.action).toEqual({ kind: "textZoom", delta: -1 });
    expect(matchShortcut(chord("0"))?.action).toEqual({ kind: "textZoom", delta: 0 });
  });

  it("o desfazer do readline (Ctrl+_ = Ctrl+Shift+-) continua chegando ao terminal", () => {
    expect(matchShortcut(chord("_", true))).toBeNull();
  });
});
