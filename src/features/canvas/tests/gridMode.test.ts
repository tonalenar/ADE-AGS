import { describe, expect, it } from "vitest";

import { gridColumns, gridTabs } from "../gridMode";
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
});
