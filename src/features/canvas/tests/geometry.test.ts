import { describe, expect, it } from "vitest";

import { BORDER, GAP, HEADER_H, NODE_DEFAULT, focusViewport, intersects, isLive, nextFreeBox, terminalRect } from "../geometry";

describe("isLive", () => {
  it("solo al 100 %", () => {
    expect(isLive(1)).toBe(true);
    expect(isLive(0.999)).toBe(true);
    expect(isLive(0.9)).toBe(false);
  });
});

describe("terminalRect", () => {
  it("va debajo de la cabecera y dentro del borde, corrida por la vista", () => {
    const r = terminalRect({ x: 100, y: 50, w: 600, h: 400 }, { x: 10, y: 20, zoom: 1 });
    expect(r).toEqual({ left: 100 + 10 + BORDER, top: 50 + 20 + HEADER_H, width: 600 - 2 * BORDER, height: 400 - HEADER_H - BORDER });
  });
});

describe("intersects", () => {
  it("una terminal fuera del área no se dibuja", () => {
    expect(intersects({ left: -900, top: 0, width: 800, height: 400 }, 1000, 800)).toBe(false);
    expect(intersects({ left: -100, top: 0, width: 800, height: 400 }, 1000, 800)).toBe(true);
  });
});

describe("nextFreeBox", () => {
  it("el primero va en el origen", () => {
    expect(nextFreeBox([])).toMatchObject({ x: 0, y: 0 });
  });

  it("los siguientes llenan dos columnas y después bajan", () => {
    const first = nextFreeBox([]);
    const second = nextFreeBox([first]);
    const third = nextFreeBox([first, second]);
    expect(second).toMatchObject({ x: NODE_DEFAULT.w + GAP, y: 0 });
    expect(third).toMatchObject({ x: 0, y: NODE_DEFAULT.h + GAP });
  });

  /// Un nodo que el usuario dejó donde iría el siguiente no se pisa: el nuevo busca otra celda.
  it("respeta un nodo movido a mano", () => {
    const moved = { x: NODE_DEFAULT.w + GAP + 30, y: 10, ...{ w: 400, h: 300 } };
    const next = nextFreeBox([{ x: 0, y: 0, ...NODE_DEFAULT }, moved]);
    expect(next).toMatchObject({ x: 0, y: NODE_DEFAULT.h + GAP });
  });
});

describe("focusViewport", () => {
  it("centra un nodo que entra", () => {
    const vp = focusViewport({ x: 0, y: 0, w: 400, h: 200 }, 1000, 800);
    expect(vp).toEqual({ x: 300, y: 300, zoom: 1 });
  });

  it("un nodo más grande que el área se alinea arriba a la izquierda", () => {
    const vp = focusViewport({ x: 500, y: 500, w: 2000, h: 2000 }, 1000, 800);
    expect(vp).toEqual({ x: 24 - 500, y: 24 - 500, zoom: 1 });
  });
});
