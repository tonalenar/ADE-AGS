import { describe, expect, it } from "vitest";

import { PRINT_SANDBOX } from "../exportBoard";
import { FRAME_MSG, FRAME_SCRIPT, parseFrameMessage } from "../frameBridge";
import { quickBarPlacement } from "../QuickBar";
import { clampPanel, PANEL_SIZE } from "../StudioPanel";
import { boardOrdinal, cycleBoard, keyAction, layoutColumns, type KeyLike } from "../studioModel";

const k = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({ key, meta: false, ctrl: false, shift: false, alt: false, phase: "down", ...o });

describe("F4: atalhos, Tab, guias, painel e ponte", () => {
  it("ferramentas de desenho e os atalhos novos", () => {
    expect(keyAction(k("t"))).toEqual({ type: "tool", tool: "text" });
    expect(keyAction(k("p"))).toEqual({ type: "tool", tool: "pencil" });
    expect(keyAction(k("P", { shift: true }))).toEqual({ type: "tool", tool: "pen" });
    expect(keyAction(k("r"))).toEqual({ type: "tool", tool: "rect" });
    expect(keyAction(k("o"))).toEqual({ type: "tool", tool: "oval" });
    expect(keyAction(k("l"))).toEqual({ type: "tool", tool: "line" });
    expect(keyAction(k("L", { shift: true }))).toEqual({ type: "tool", tool: "arrow" });
    expect(keyAction(k("G", { shift: true }))).toEqual({ type: "guides" });
    expect(keyAction(k("z", { meta: true }))).toEqual({ type: "undo" });
    expect(keyAction(k("z", { meta: true, shift: true }))).toEqual({ type: "redo" });
    expect(keyAction(k("\\", { meta: true }))).toEqual({ type: "panel" });
    expect(keyAction(k("Tab"))).toEqual({ type: "cycle", dir: 1 });
    expect(keyAction(k("Tab", { shift: true }))).toEqual({ type: "cycle", dir: -1 });
    expect(keyAction(k("H", { shift: true }))).toBeNull();
  });

  it("Tab percorre as pranchetas em ordem de leitura e dá a volta", () => {
    const boards = [{ id: "b", x: 500, y: 0 }, { id: "c", x: 0, y: 900 }, { id: "a", x: 0, y: 0 }];
    expect(cycleBoard(boards, null, 1)).toBe("a");
    expect(cycleBoard(boards, null, -1)).toBe("c");
    expect(cycleBoard(boards, "a", 1)).toBe("b");
    expect(cycleBoard(boards, "c", 1)).toBe("a");
    expect(cycleBoard(boards, "a", -1)).toBe("c");
    expect(cycleBoard([], null, 1)).toBeNull();
    expect(boardOrdinal(boards, "b")).toEqual({ i: 2, n: 3 });
  });

  it("guias de 12 colunas dentro da largura", () => {
    const cols = layoutColumns(1280);
    expect(cols).toHaveLength(12);
    expect(cols[0].x).toBeGreaterThan(0);
    expect(cols[11].x + cols[11].w).toBeLessThanOrEqual(1280);
    expect(layoutColumns(10)).toEqual([]);
  });

  it("painel de 312 px preso entre os limites e barra rápida dentro da área", () => {
    expect(PANEL_SIZE.initial).toBe(312);
    expect(clampPanel(10)).toBe(PANEL_SIZE.min);
    expect(clampPanel(9999)).toBe(PANEL_SIZE.max);
    expect(clampPanel(Number.NaN)).toBe(312);
    expect(quickBarPlacement({ x: 100, y: 200, w: 50, h: 20 }, 1000)).toEqual({ left: 100, top: 160 });
    expect(quickBarPlacement({ x: 900, y: 10, w: 50, h: 20 }, 1000)).toEqual({ left: 696, top: 38 });
  });

  it("a impressão nunca junta scripts com mesma origem", () => {
    expect(PRINT_SANDBOX).not.toContain("allow-scripts");
  });

  it("ponte: árvore de camadas, texto editado e a caixa do elemento escolhido", () => {
    const msg = (o: Record<string, unknown>) => ({ type: FRAME_MSG, ...o });
    expect(parseFrameMessage(msg({ kind: "tree", nodes: [{ selector: "p", tag: "p", depth: 99 }, { tag: "x" }] }))).toEqual({
      kind: "tree", nodes: [{ selector: "p", tag: "p", id: "", cls: "", text: "", depth: 12 }],
    });
    expect(parseFrameMessage(msg({ kind: "textEdited", selector: "h1", html: "x" }))).toEqual({ kind: "textEdited", selector: "h1", html: "x" });
    expect(parseFrameMessage(msg({ kind: "textEdited", selector: "", html: "x" }))).toBeNull();
    expect(parseFrameMessage(msg({ kind: "select", selector: "a", rect: { x: 1, y: 2, w: 3, h: 4 } }))).toMatchObject({ rect: { x: 1, y: 2, w: 3, h: 4 } });
    expect(FRAME_SCRIPT).toContain("contenteditable");
    expect(FRAME_SCRIPT).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
