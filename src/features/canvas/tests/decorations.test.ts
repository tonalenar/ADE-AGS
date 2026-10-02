import { describe, expect, it } from "vitest";

import {
  IMAGE_MAX_SIDE, addImage, addStroke, addText, boxOf, emptyBoard, isFreeNodeId, removeImage, removeStroke,
  removeText, strokePath, thin, undoStroke, updateText,
} from "../board";

describe("textos", () => {
  it("un rótulo nuevo nace donde se pidió y con el alto de su letra", () => {
    const b = addText(emptyBoard(), { id: "text-1", at: { x: 10.4, y: 20.6 }, size: 32 });
    expect(b.texts["text-1"].box).toMatchObject({ x: 10, y: 21 });
    expect(b.texts["text-1"].box.h).toBeGreaterThan(32);
    expect(boxOf(b, "text-1")).toBe(b.texts["text-1"].box);
  });

  it("se edita y se borra", () => {
    let b = addText(emptyBoard(), { id: "text-1", at: { x: 0, y: 0 } });
    b = updateText(b, "text-1", { text: "Backend", size: 48 });
    expect(b.texts["text-1"]).toMatchObject({ text: "Backend", size: 48 });
    expect(updateText(b, "nada", { text: "x" })).toBe(b);
    b = removeText(b, "text-1");
    expect(b.texts).toEqual({});
    expect(removeText(b, "text-1")).toBe(b);
  });
});

describe("imágenes", () => {
  it("la más grande se reduce a su lado máximo conservando la proporción, centrada", () => {
    const b = addImage(emptyBoard(), { id: "image-1", name: "a.png", asset: "x.png", width: 1680, height: 840, at: { x: 0, y: 0 } });
    const box = b.images["image-1"].box;
    expect(box.w).toBe(IMAGE_MAX_SIDE);
    expect(box.h).toBe(IMAGE_MAX_SIDE / 2);
    expect(box.x).toBe(-IMAGE_MAX_SIDE / 2);
  });

  it("una chica no se agranda", () => {
    const b = addImage(emptyBoard(), { id: "image-1", name: "i.png", asset: "x.png", width: 100, height: 60, at: { x: 0, y: 0 } });
    expect(b.images["image-1"].box).toMatchObject({ w: 100, h: 60 });
  });

  it("una degenerada (0×0) no produce un nodo invisible", () => {
    const b = addImage(emptyBoard(), { id: "image-1", name: "i", asset: "x.png", width: 0, height: 0, at: { x: 0, y: 0 } });
    expect(b.images["image-1"].box.w).toBeGreaterThanOrEqual(40);
  });

  it("se borra", () => {
    let b = addImage(emptyBoard(), { id: "image-1", name: "i", asset: "x.png", width: 10, height: 10, at: { x: 0, y: 0 } });
    b = removeImage(b, "image-1");
    expect(b.images).toEqual({});
  });
});

describe("trazos", () => {
  const stroke = (id: string) => ({ id, points: [0, 0, 10, 10, 20, 0], color: "#f00", width: 4 });

  it("se agregan, se deshacen de a uno y se borran por id", () => {
    let b = addStroke(emptyBoard(), stroke("a"));
    b = addStroke(b, stroke("b"));
    expect(b.drawings.map((s) => s.id)).toEqual(["a", "b"]);
    expect(undoStroke(b).drawings.map((s) => s.id)).toEqual(["a"]);
    expect(removeStroke(b, "a").drawings.map((s) => s.id)).toEqual(["b"]);
    expect(removeStroke(b, "zzz")).toBe(b);
    expect(undoStroke(emptyBoard())).toEqual(emptyBoard());
  });

  it("un trazo sin al menos dos puntos no se guarda", () => {
    const b = emptyBoard();
    expect(addStroke(b, { id: "x", points: [1, 1], color: "#000", width: 2 })).toBe(b);
  });

  it("thin quita los puntos casi iguales pero conserva los extremos", () => {
    const pts = [0, 0, 0.2, 0, 0.4, 0, 5, 0, 5.1, 0, 10, 0];
    expect(thin(pts, 1)).toEqual([0, 0, 5, 0, 10, 0]);
    expect(thin([0, 0, 1, 1], 5)).toEqual([0, 0, 1, 1]);
  });

  it("el camino SVG empieza en el primer punto y termina en el último", () => {
    expect(strokePath([0, 0, 10, 10])).toBe("M0 0 L10 10");
    const d = strokePath([0, 0, 10, 10, 20, 0]);
    expect(d.startsWith("M0 0")).toBe(true);
    expect(d.endsWith("L20 0")).toBe(true);
    expect(strokePath([1, 1])).toBe("");
  });
});

describe("ids de nodos libres", () => {
  it("reconoce notas, portales, textos e imágenes, y no las tabs", () => {
    for (const id of ["note-1", "portal-1", "text-1", "image-1"]) expect(isFreeNodeId(id)).toBe(true);
    for (const id of ["abc", "t1", "tab-note-1", ""]) expect(isFreeNodeId(id)).toBe(false);
  });
});
