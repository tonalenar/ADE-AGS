import { beforeEach, describe, expect, it, vi } from "vitest";

import { addFolder, addNote, addPortal, addText, emptyBoard, NOTE_MIN } from "../board";
import { boxFromDrag, clampSize, defaultSize, isDrag, KIND_DEFAULT, KIND_MIN, loadSizes, MAX_SIDE, parseSizes, rememberSize, sizeLabel, SIZES_KEY } from "../placeBox";

describe("criar um elemento desenhando o retângulo", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    });
  });

  it("um arrasto vale em qualquer sentido e guarda o canto de partida", () => {
    expect(boxFromDrag("portal", { x: 100, y: 100 }, { x: 500, y: 400 }, 1)).toEqual({ x: 100, y: 100, w: 400, h: 300 });
    expect(boxFromDrag("portal", { x: 500, y: 400 }, { x: 100, y: 100 }, 1)).toEqual({ x: 100, y: 100, w: 400, h: 300 });
    expect(boxFromDrag("portal", { x: 500, y: 100 }, { x: 100, y: 400 }, 1)).toEqual({ x: 100, y: 100, w: 400, h: 300 });
  });

  it("o tamanho respeita o mínimo do tipo, alargando para o lado em que se arrastou", () => {
    const small = boxFromDrag("note", { x: 300, y: 300 }, { x: 260, y: 250 }, 1);
    expect(small).toEqual({ x: 300 - NOTE_MIN.w, y: 300 - NOTE_MIN.h, w: NOTE_MIN.w, h: NOTE_MIN.h });
    expect(clampSize("terminal", { w: 10, h: 10 })).toEqual(KIND_MIN.terminal);
    expect(clampSize("note", { w: 99999, h: 5 }).w).toBe(MAX_SIDE);
    expect(clampSize("note", { w: Number.NaN, h: Number.NaN })).toEqual(KIND_MIN.note);
  });

  it("um clique solto cria o tamanho padrão centrado no ponto; o lembrado vence o de fábrica", () => {
    expect(boxFromDrag("note", { x: 1000, y: 500 }, { x: 1002, y: 501 }, 1)).toEqual({
      x: 1000 - KIND_DEFAULT.note.w / 2, y: 500 - KIND_DEFAULT.note.h / 2, w: KIND_DEFAULT.note.w, h: KIND_DEFAULT.note.h,
    });
    const remembered = { note: { w: 500, h: 300 } };
    expect(boxFromDrag("note", { x: 0, y: 0 }, { x: 0, y: 0 }, 1, remembered)).toEqual({ x: -250, y: -150, w: 500, h: 300 });
    expect(defaultSize("note", remembered)).toEqual({ w: 500, h: 300 });
    expect(defaultSize("portal", remembered)).toEqual(KIND_DEFAULT.portal);
  });

  it("o limiar de arrasto conta em pixels da tela, não do canvas", () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 6, y: 0 }, 1)).toBe(false);
    expect(isDrag({ x: 0, y: 0 }, { x: 10, y: 0 }, 1)).toBe(true);
    // Com zoom 0.15, 10 px do canvas são 1,5 px na tela: ainda é só um clique.
    expect(isDrag({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.15)).toBe(false);
    expect(isDrag({ x: 0, y: 0 }, { x: 80, y: 0 }, 0.15)).toBe(true);
  });

  it("lembra o tamanho por tipo, esquece, e ignora lixo guardado", () => {
    let sizes = rememberSize({}, "portal", { w: 800, h: 500 });
    expect(loadSizes()).toEqual({ portal: { w: 800, h: 500 } });
    sizes = rememberSize(sizes, "note", { w: 10, h: 10 });
    expect(sizes.note).toEqual(KIND_MIN.note);
    sizes = rememberSize(sizes, "portal", null);
    expect(sizes.portal).toBeUndefined();
    expect(parseSizes(null)).toEqual({});
    expect(parseSizes("{nao é json")).toEqual({});
    expect(parseSizes("[1,2]")).toEqual({});
    expect(parseSizes(JSON.stringify({ portal: { w: "x", h: 1 }, ufo: { w: 1, h: 1 }, note: { w: 400, h: 300 } }))).toEqual({ note: { w: 400, h: 300 } });
    localStorage.setItem(SIZES_KEY, "lixo");
    expect(loadSizes()).toEqual({});
    expect(sizeLabel({ w: 640.4, h: 440.6 })).toBe("640 × 441");
  });

  it("os elementos nascem no tamanho desenhado", () => {
    const size = { w: 410, h: 270 };
    const at = { x: 50, y: 60 };
    const note = addNote(emptyBoard(), { id: "note-1", content: "", at, size }).board.notes["note-1"].box;
    expect(note).toEqual({ x: 50, y: 60, w: 410, h: 270 });
    const portal = addPortal(emptyBoard(), { id: "portal-1", at, size }).board.portals["portal-1"].box;
    expect(portal).toEqual({ x: 50, y: 60, w: 410, h: 270 });
    const text = addText(emptyBoard(), { id: "text-1", at, box: size }).texts["text-1"].box;
    expect(text).toEqual({ x: 50, y: 60, w: 410, h: 270 });
    const folder = addFolder(emptyBoard(), { id: "folder-1", path: "C:/x", name: "x", at, size }).folders["folder-1"].box;
    expect(folder).toEqual({ x: 50, y: 60, w: 410, h: 270 });
    // Sem tamanho, nada muda: continua o de fábrica.
    expect(addNote(emptyBoard(), { id: "note-2", content: "", at }).board.notes["note-2"].box).toMatchObject({ w: 320, h: 240 });
  });
});
