import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../board";
import type { Artboard, Design, DesignDetail } from "../designApi";
import { AREA_GAP, designsForBoard, freeOrigin, layoutGroups, positionsToSave } from "../scope";

const design = (id: string, over: Partial<Design> = {}): Design => ({ id, workspace: "C:\proj", missionId: null, ownerTabId: null, title: id, status: "draft", ...over });
const board = (id: string, x = 0, y = 0, pageId = "p1"): Artboard => ({ id, pageId, title: id, html: "", width: 400, height: 300, x, y, version: 1, status: "draft" });
const detail = (d: Design, artboards: Artboard[]): DesignDetail => ({ design: d, pages: [{ id: "p1", designId: d.id, name: "Home", order: 0 }], artboards, comments: [], versions: {} });

describe("designsForBoard", () => {
  const all = [design("a"), design("b", { missionId: "m1" }), design("c", { workspace: "C:\outra" })];
  it("canvas de missão: só os da missão", () => {
    expect(designsForBoard(all, { cwd: "C:\proj", missionId: "m1" }).map((d) => d.id)).toEqual(["b"]);
  });
  it("canvas de pasta: os da pasta sem missão", () => {
    expect(designsForBoard(all, { cwd: "C:\proj", missionId: null }).map((d) => d.id)).toEqual(["a"]);
  });
  it("sem pasta, nada", () => {
    expect(designsForBoard(all, { cwd: null, missionId: null })).toEqual([]);
  });
});

describe("freeOrigin", () => {
  it("canvas vazio começa em 0,0", () => expect(freeOrigin(emptyBoard())).toEqual({ x: 0, y: 0 }));
  it("fica à direita de tudo", () => {
    const b = emptyBoard();
    b.nodes = { t1: { x: 10, y: 20, w: 500, h: 300 }, t2: { x: 600, y: 0, w: 400, h: 300 } };
    expect(freeOrigin(b)).toEqual({ x: 1000 + AREA_GAP, y: 0 });
  });
});

describe("layoutGroups", () => {
  it("pranchetas empilhadas em 0,0 saem lado a lado dentro da moldura", () => {
    const [g] = layoutGroups([detail(design("d1", { title: "Polir" }), [board("a"), board("b")])], { x: 1000, y: 0 });
    expect(g.title).toBe("Polir/Home");
    expect(g.boards[1].x).toBeGreaterThan(g.boards[0].x + 400);
    expect(g.boards.every((b) => b.x >= g.frame.x && b.x + 400 <= g.frame.x + g.frame.w)).toBe(true);
  });
  it("páginas e designs não se cobrem", () => {
    const groups = layoutGroups([detail(design("d1"), [board("a")]), detail(design("d2"), [board("b")])], { x: 0, y: 0 });
    expect(groups[1].frame.y).toBeGreaterThanOrEqual(groups[0].frame.y + groups[0].frame.h);
  });
  it("design sem prancheta não gera moldura", () => {
    expect(layoutGroups([detail(design("d1"), [])], { x: 0, y: 0 })).toEqual([]);
  });
  it("mover uma prancheta grava posição relativa", () => {
    const [g] = layoutGroups([detail(design("d1"), [board("a", 100, 50)])], { x: 1000, y: 0 });
    const at = g.boards[0];
    expect(positionsToSave(g, "a", at.x + 30, at.y - 10)).toEqual([{ id: "a", x: 130, y: 40 }]);
  });
  it("ao mover uma de várias empilhadas, grava também as irmãs espalhadas", () => {
    const [g] = layoutGroups([detail(design("d1"), [board("a"), board("b")])], { x: 0, y: 0 });
    const saved = positionsToSave(g, "a", g.boards[0].x, g.boards[0].y + 50);
    expect(saved).toEqual([{ id: "a", x: 0, y: 50 }, { id: "b", x: g.boards[1].lx, y: 0 }]);
  });
});

import { freshDesigns } from "../scope";
describe("freshDesigns", () => {
  it("só os que ainda não eram conhecidos", () => {
    expect(freshDesigns(new Set(["a"]), [design("a"), design("b")]).map((d) => d.id)).toEqual(["b"]);
    expect(freshDesigns(new Set(["a"]), [design("a")])).toEqual([]);
  });
});
