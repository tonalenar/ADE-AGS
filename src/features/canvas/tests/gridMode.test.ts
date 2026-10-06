import { describe, expect, it } from "vitest";

import { GRID_SLOT, gridColumns, gridPlacements, gridTabs, usableSlot } from "../gridMode";
import { parseGrids } from "../store";

describe("gridMode", () => {
  it("columnas casi cuadradas", () => {
    expect([1, 2, 3, 4, 5, 9, 10].map(gridColumns)).toEqual([1, 2, 2, 2, 3, 3, 4]);
  });
  it("solo aplica con opción activa, misión, abas y 2+ panes", () => {
    const base = { on: true, mission: "m", mode: "tabs", tabIds: ["a", "b"] };
    expect(gridTabs(base)).toEqual(["a", "b"]);
    expect(gridTabs({ ...base, on: false })).toBeNull();
    expect(gridTabs({ ...base, mission: null })).toBeNull();
    expect(gridTabs({ ...base, mode: "canvas" })).toBeNull();
    expect(gridTabs({ ...base, tabIds: ["a"] })).toBeNull();
  });
  it("lo persistido es por misión y descarta basura", () => {
    expect(parseGrids('{"k1":true,"k2":false,"k3":"x"}')).toEqual({ k1: true });
    expect(parseGrids("no json")).toEqual({});
    expect(parseGrids("[1]")).toEqual({});
    expect(parseGrids(null)).toEqual({});
  });

  describe("posicionamiento (regresión: quadro vazio)", () => {
    const r = (left: number, top: number, width = 400, height = 300) => ({ left, top, width, height });

    it("un hueco solo sirve si está medido y tiene tamaño real", () => {
      expect(usableSlot(r(0, 0))).toBe(true);
      expect(usableSlot(undefined)).toBe(false);
      expect(usableSlot(null)).toBe(false);
      expect(usableSlot(r(0, 0, 0, 300))).toBe(false);
      expect(usableSlot(r(0, 0, 400, 0))).toBe(false);
    });

    it("cada pane recibe el rect de su hueco grid:<id>", () => {
      const slots = { [GRID_SLOT + "a"]: r(0, 24), [GRID_SLOT + "b"]: r(400, 24) };
      const out = gridPlacements(["a", "b"], slots);
      expect(out.get("a")).toEqual(r(0, 24));
      expect(out.get("b")).toEqual(r(400, 24));
    });

    it("un pane sin medir NO se ubica (antes ocupaba toda el área y tapaba a los demás)", () => {
      const out = gridPlacements(["a", "b"], { [GRID_SLOT + "a"]: r(0, 24) });
      expect([...out.keys()]).toEqual(["a"]);
    });

    it("huecos 0x0 (layout todavía sin resolver) quedan fuera: xterm no se monta sin tamaño", () => {
      const out = gridPlacements(["a", "b"], { [GRID_SLOT + "a"]: r(0, 0, 0, 0), [GRID_SLOT + "b"]: r(0, 0, 0, 0) });
      expect(out.size).toBe(0);
    });

    it("ignora huecos de otros paneles (grupos del árbol normal) y ids fuera de la grade", () => {
      const slots = { g1: r(0, 0), [GRID_SLOT + "x"]: r(0, 0), [GRID_SLOT + "a"]: r(5, 5) };
      expect([...gridPlacements(["a"], slots).keys()]).toEqual(["a"]);
    });
  });
});
