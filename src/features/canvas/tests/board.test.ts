import { describe, expect, it } from "vitest";

import { addEdge, emptyBoard, neighbors, placeBelow, reconcile, removeEdge, removeEdgeBetween, toggleOrchestrator } from "../board";
import { GAP } from "../geometry";

describe("reconcile", () => {
  it("da lugar a las tabs nuevas", () => {
    const b = reconcile(emptyBoard(), ["t1", "t2"]);
    expect(Object.keys(b.nodes)).toEqual(["t1", "t2"]);
    expect(b.nodes.t1).not.toEqual(b.nodes.t2);
  });

  it("una tab cerrada se va con sus conexiones", () => {
    let b = reconcile(emptyBoard(), ["t1", "t2", "t3"]);
    b = addEdge(b, "t1", "t2", "e1");
    b = addEdge(b, "t2", "t3", "e2");
    b = reconcile(b, ["t1", "t3"]);
    expect(Object.keys(b.nodes)).toEqual(["t1", "t3"]);
    expect(b.edges).toEqual([]);
  });

  it("sin cambios devuelve el mismo objeto", () => {
    const b = reconcile(emptyBoard(), ["t1"]);
    expect(reconcile(b, ["t1"])).toBe(b);
  });

  it("no mueve a las que ya tenían lugar", () => {
    const b = reconcile(emptyBoard(), ["t1"]);
    const moved = { ...b, nodes: { t1: { x: 999, y: 999, w: 500, h: 300 } } };
    expect(reconcile(moved, ["t1", "t2"]).nodes.t1).toEqual({ x: 999, y: 999, w: 500, h: 300 });
  });
});

describe("addEdge", () => {
  it("conecta una vez, en cualquier sentido", () => {
    let b = addEdge(emptyBoard(), "a", "b", "e1");
    b = addEdge(b, "b", "a", "e2");
    expect(b.edges).toEqual([{ id: "e1", a: "a", b: "b" }]);
  });

  it("no conecta una terminal consigo misma", () => {
    const b = emptyBoard();
    expect(addEdge(b, "a", "a")).toBe(b);
  });
});

describe("removeEdge y neighbors", () => {
  it("los vecinos salen de los dos lados de cada conexión", () => {
    let b = addEdge(emptyBoard(), "a", "b", "e1");
    b = addEdge(b, "c", "a", "e2");
    expect(neighbors(b, "a").sort()).toEqual(["b", "c"]);
    expect(neighbors(removeEdge(b, "e2"), "a")).toEqual(["b"]);
  });
});

describe("orquestadoras", () => {
  it("se marcan y se desmarcan", () => {
    const b = toggleOrchestrator(emptyBoard(), "lider");
    expect(b.orchestrators).toEqual(["lider"]);
    expect(toggleOrchestrator(b, "lider").orchestrators).toEqual([]);
  });

  it("una tab cerrada deja de ser orquestadora", () => {
    let b = reconcile(emptyBoard(), ["lider", "a"]);
    b = toggleOrchestrator(b, "lider");
    expect(reconcile(b, ["a"]).orchestrators).toEqual([]);
  });
});

describe("placeBelow", () => {
  it("pone al recluta en la fila de abajo de su orquestadora", () => {
    let b = reconcile(emptyBoard(), ["lider", "nuevo"]);
    b = placeBelow(b, "nuevo", "lider");
    const lider = b.nodes.lider!;
    expect(b.nodes.nuevo).toMatchObject({ x: lider.x, y: lider.y + lider.h + GAP });
  });

  it("si abajo está ocupado, corre a la derecha", () => {
    // Como llegan de verdad: uno por vez, cada uno ubicado al sumarse.
    let b = reconcile(emptyBoard(), ["lider", "a"]);
    b = placeBelow(b, "a", "lider");
    b = reconcile(b, ["lider", "a", "b"]);
    b = placeBelow(b, "b", "lider");
    expect(b.nodes.b!.x).toBeGreaterThan(b.nodes.a!.x);
    expect(b.nodes.b!.y).toBe(b.nodes.a!.y);
  });
});

describe("removeEdgeBetween", () => {
  it("quita la conexión en cualquier sentido", () => {
    const b = addEdge(emptyBoard(), "a", "b", "e1");
    expect(removeEdgeBetween(b, "b", "a").edges).toEqual([]);
  });
});
