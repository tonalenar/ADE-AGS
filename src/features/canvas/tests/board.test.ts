import { describe, expect, it } from "vitest";

import {
  addEdge, buildMissionTeam, emptyBoard, gridCell, neighbors, placeBelow, reconcile, removeEdge, removeEdgeBetween, toggleOrchestrator,
} from "../board";
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

describe("recruits", () => {
  it("usa la proxima celda de la grilla y evita panes existentes", async () => {
    const { canvasActions, useCanvasStore } = await import("../store");
    const key = "main|/mission-grid";
    const initial = buildMissionTeam(emptyBoard(), "lead", [{ tabId: "w1" }]);
    const lead = initial.nodes.lead!;
    const cellW = lead.w + GAP;
    const cellH = lead.h + GAP;
    const occupiedCell = gridCell(2);
    const openedBefore = {
      x: lead.x + occupiedCell.col * cellW,
      y: lead.y + occupiedCell.row * cellH,
      w: lead.w,
      h: lead.h,
    };
    useCanvasStore.setState({
      boards: { [key]: { ...initial, nodes: { ...initial.nodes, openedBefore } } },
    });

    canvasActions.recruited(key, "w2", "lead");

    const board = useCanvasStore.getState().boards[key];
    const nextCell = gridCell(3);
    expect(board.nodes.w2).toMatchObject({
      x: lead.x + nextCell.col * cellW,
      y: lead.y + nextCell.row * cellH,
    });
    expect(board.nodes.openedBefore).toEqual(openedBefore);
    expect(board.edges).toHaveLength(2);

    const boxes = Object.values(board.nodes);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
  });
});
describe("papeles", () => {
  it("un agente recrutado con papel lo lleva en el canvas", async () => {
    const { canvasActions, useCanvasStore } = await import("../store");
    const key = "main|/p";
    useCanvasStore.setState({ boards: { [key]: reconcile(emptyBoard(), ["lead", "w1"]) } });
    canvasActions.recruited(key, "w1", "lead", "Reviewer");
    expect(useCanvasStore.getState().boards[key].roles).toEqual({ w1: "Reviewer" });
    expect(useCanvasStore.getState().boards[key].edges).toHaveLength(1);
  });

  it("sin papel no se anota nada", async () => {
    const { canvasActions, useCanvasStore } = await import("../store");
    const key = "main|/q";
    useCanvasStore.setState({ boards: { [key]: reconcile(emptyBoard(), ["lead", "w1"]) } });
    canvasActions.recruited(key, "w1", "lead", null);
    expect(useCanvasStore.getState().boards[key].roles).toEqual({});
  });

  it("el papel de una tab cerrada se va con ella, y sin cambios devuelve el mismo objeto", () => {
    let b = reconcile(emptyBoard(), ["t1", "t2"]);
    b = { ...b, roles: { t1: "QA", t2: "Reviewer" } };
    expect(reconcile(b, ["t1", "t2"])).toBe(b);
    expect(reconcile(b, ["t1"]).roles).toEqual({ t1: "QA" });
  });
});

describe("pisos", () => {
  it("una conexión con un agente de otro piso sobrevive mientras ese agente siga abierto", () => {
    // `t1` está en este canvas; `w1` es su recluta en otro piso (otro canvas).
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addEdge(b, "t1", "w1", "e1");
    expect(reconcile(b, ["t1"], ["t1", "w1"]).edges).toHaveLength(1);
    expect(reconcile(b, ["t1"], ["t1"]).edges).toEqual([]);
  });

  it("sin el tercer argumento se comporta como antes", () => {
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addEdge(b, "t1", "w1", "e1");
    expect(reconcile(b, ["t1"]).edges).toEqual([]);
  });
});
