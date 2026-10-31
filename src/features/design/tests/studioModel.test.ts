import { describe, expect, it } from "vitest";

import { designRoute, parseDesignOpen } from "../openRoute";
import { keyAction, modSymbol, nextName, nextTool, noteBg, noteMaxHeight, openCommand, type KeyLike } from "../studioModel";

const k = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({ key, meta: false, ctrl: false, shift: false, alt: false, phase: "down", ...o });

describe("atalhos e ferramentas", () => {
  it("letras de ferramenta sem modificador; Esc; zoom com ⌘/Ctrl", () => {
    expect(keyAction(k("h"))).toEqual({ type: "tool", tool: "hand" });
    expect(keyAction(k("A"))).toEqual({ type: "tool", tool: "artboard" });
    expect(keyAction(k("n"))).toEqual({ type: "tool", tool: "note" });
    expect(keyAction(k("c"))).toEqual({ type: "tool", tool: "comment" });
    expect(keyAction(k("c", { meta: true }))).toBeNull();
    expect(keyAction(k("h", { alt: true }))).toBeNull();
    expect(keyAction(k("Escape"))).toEqual({ type: "escape" });
    expect(keyAction(k("0", { meta: true }))).toEqual({ type: "fit" });
    expect(keyAction(k("=", { ctrl: true }))).toEqual({ type: "zoomIn" });
    expect(keyAction(k("+", { meta: true }))).toEqual({ type: "zoomIn" });
    expect(keyAction(k("-", { meta: true }))).toEqual({ type: "zoomOut" });
    expect(keyAction(k("d", { meta: true }))).toEqual({ type: "duplicate" });
    expect(keyAction(k("Backspace"))).toEqual({ type: "delete" });
    expect(keyAction(k(" "))).toEqual({ type: "spaceDown" });
    expect(keyAction(k(" ", { phase: "up" }))).toEqual({ type: "spaceUp" });
    expect(keyAction(k("h", { phase: "up" }))).toBeNull();
    expect(keyAction(k("x"))).toBeNull();
  });

  it("clicar de novo na ferramenta ativa volta à Seleção", () => {
    expect(nextTool("hand", "hand")).toBe("select");
    expect(nextTool("select", "note")).toBe("note");
    expect(nextTool("select", "select")).toBe("select");
  });

  it("notas, nomes, links e o modificador", () => {
    expect(noteBg("teal")).toBe("bg-teal-100");
    expect(noteBg("<script>")).toBe("bg-amber-100");
    expect(noteMaxHeight(240)).toBe(320);
    expect(nextName("Página", ["Página 1", "Página 2"])).toBe("Página 3");
    expect(nextName("Página", ["Página 2"])).toBe("Página 3");
    expect(openCommand("d1", { artboardId: "b1" })).toBe("ags design open d1 --artboard b1");
    expect(modSymbol("MacIntel")).toBe("⌘");
    expect(modSymbol("Win32")).toBe("Ctrl+");
  });

  it("design.open: rota da tela cheia e argumentos validados", () => {
    expect(designRoute({ designId: "d 1", artboardId: "b1", seq: 5 })).toBe("/design/d%201?artboard=b1&seq=5");
    expect(designRoute({ designId: "d1" })).toBe("/design/d1");
    expect(parseDesignOpen({ designId: "d1", title: "x", pageId: null, artboardId: "b" })).toEqual({ designId: "d1", artboardId: "b", pageId: null });
    expect(() => parseDesignOpen({})).toThrow();
  });
});
