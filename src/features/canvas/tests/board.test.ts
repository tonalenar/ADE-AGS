import { describe, expect, it } from "vitest";

import { addEdge, emptyBoard, neighbors, reconcile, removeEdge } from "../board";

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
