import { describe, expect, it } from "vitest";

import { BORDER, GAP, HEADER_H, LIVE_MIN_ZOOM, NODE_DEFAULT, facingSides, focusViewport, intersects, isLive, nextFreeBox, terminalRect } from "../geometry";

describe("isLive", () => {
  it("viva desde LIVE_MIN_ZOOM hasta el 100 %; más alejado, vista previa", () => {
    expect(isLive(1)).toBe(true);
    expect(isLive(0.999)).toBe(true);
    expect(isLive(0.9)).toBe(true);
    expect(isLive(0.5)).toBe(true);
    expect(isLive(LIVE_MIN_ZOOM)).toBe(true);
    expect(isLive(LIVE_MIN_ZOOM - 0.01)).toBe(false);
    expect(isLive(0.15)).toBe(false);
  });
});

describe("terminalRect", () => {
  it("va debajo de la cabecera y dentro del borde, corrida por la vista", () => {
    const r = terminalRect({ x: 100, y: 50, w: 600, h: 400 }, { x: 10, y: 20, zoom: 1 });
    expect(r).toEqual({ left: 100 + 10 + BORDER, top: 50 + 20 + HEADER_H, width: 600 - 2 * BORDER, height: 400 - HEADER_H - BORDER });
    expect(r.scale).toBeUndefined();
  });

  it("alejado conserva el tamaño REAL (mismas filas y columnas) y escala la posición", () => {
    const box = { x: 100, y: 50, w: 600, h: 400 };
    const full = terminalRect(box, { x: 0, y: 0, zoom: 1 });
    const half = terminalRect(box, { x: 10, y: 20, zoom: 0.5 });
    expect(half.width).toBe(full.width);
    expect(half.height).toBe(full.height);
    expect(half.scale).toBe(0.5);
    expect(half.left).toBe(Math.round(100 * 0.5 + 10 + BORDER * 0.5));
    expect(half.top).toBe(Math.round(50 * 0.5 + 20 + HEADER_H * 0.5));
  });

  it("una vista con zoom roto no rompe la posición", () => {
    const r = terminalRect({ x: 0, y: 0, w: 600, h: 400 }, { x: 0, y: 0, zoom: 0 });
    expect(Number.isFinite(r.left) && Number.isFinite(r.top)).toBe(true);
  });
});

describe("intersects", () => {
  it("una terminal fuera del área no se dibuja", () => {
    expect(intersects({ left: -900, top: 0, width: 800, height: 400 }, 1000, 800)).toBe(false);
    expect(intersects({ left: -100, top: 0, width: 800, height: 400 }, 1000, 800)).toBe(true);
  });

  it("cuenta la escala: una terminal grande pero achicada que queda fuera no se dibuja", () => {
    // 800 de ancho real a escala 0.5 = 400 en pantalla: -500 + 400 < 0, está fuera.
    expect(intersects({ left: -500, top: 0, width: 800, height: 400, scale: 0.5 }, 1000, 800)).toBe(false);
    // Sin la escala (800) sí se vería: la escala es lo que decide.
    expect(intersects({ left: -500, top: 0, width: 800, height: 400 }, 1000, 800)).toBe(true);
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

describe("facingSides", () => {
  const box = (x: number, y: number) => ({ x, y, w: 400, h: 300 });

  it("lado a lado, por los costados que se miran", () => {
    expect(facingSides(box(0, 0), box(600, 50))).toEqual(["r", "l"]);
    expect(facingSides(box(600, 0), box(0, 50))).toEqual(["l", "r"]);
  });

  it("uno debajo del otro, por abajo y por arriba", () => {
    expect(facingSides(box(0, 0), box(100, 500))).toEqual(["b", "t"]);
    expect(facingSides(box(0, 500), box(100, 0))).toEqual(["t", "b"]);
  });
});
