import { describe, expect, it } from "vitest";

import { addEdge, addNote, boxOf, defaultNoteName, emptyBoard, reconcile, removeNote, uniqueNoteName, updateNote } from "../board";

describe("notas", () => {
  it("una nota creada cerca de un agente queda conectada a él y sin taparlo", () => {
    const base = reconcile(emptyBoard(), ["t1"]);
    const { board, name } = addNote(base, { id: "note-1", content: "# Plano\n- tests", near: "t1" });
    expect(name).toBe("Plano");
    expect(board.edges).toEqual([expect.objectContaining({ a: "t1", b: "note-1" })]);
    const agent = board.nodes.t1;
    const note = board.notes["note-1"].box;
    expect(note.x).toBeGreaterThanOrEqual(agent.x + agent.w);
  });

  it("dos notas cerca del mismo agente no se pisan", () => {
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addNote(b, { id: "note-1", content: "a", near: "t1" }).board;
    b = addNote(b, { id: "note-2", content: "b", near: "t1" }).board;
    const [n1, n2] = [b.notes["note-1"].box, b.notes["note-2"].box];
    expect(n2.y).toBeGreaterThanOrEqual(n1.y + n1.h);
  });

  it("los nombres repetidos se desambiguan", () => {
    let b = addNote(emptyBoard(), { id: "note-1", name: "Plano", content: "" }).board;
    const second = addNote(b, { id: "note-2", name: "plano", content: "" });
    expect(second.name).toBe("plano 2");
    b = second.board;
    expect(uniqueNoteName(b, "Plano", "note-1")).toBe("Plano");
    expect(updateNote(b, "note-2", { name: "Plano" }).notes["note-2"].name).toBe("Plano 2");
  });

  it("el nombre por defecto es la primera línea con texto", () => {
    expect(defaultNoteName("\n\n## Pendências\nx")).toBe("Pendências");
    expect(defaultNoteName("")).toBe("Nota");
  });

  it("cerrar una tab no se lleva las notas ni la conexión entre dos notas", () => {
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addNote(b, { id: "note-1", content: "a", near: "t1" }).board;
    b = addNote(b, { id: "note-2", content: "b" }).board;
    b = addEdge(b, "note-1", "note-2", "e2");
    b = reconcile(b, []);
    expect(Object.keys(b.notes)).toEqual(["note-1", "note-2"]);
    expect(b.edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("borrar una nota se lleva sus conexiones", () => {
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addNote(b, { id: "note-1", content: "a", near: "t1" }).board;
    b = removeNote(b, "note-1");
    expect(b.notes).toEqual({});
    expect(b.edges).toEqual([]);
  });

  it("boxOf encuentra terminales y notas", () => {
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addNote(b, { id: "note-1", content: "", at: { x: 10, y: 20 } }).board;
    expect(boxOf(b, "t1")).toBe(b.nodes.t1);
    expect(boxOf(b, "note-1")).toMatchObject({ x: 10, y: 20 });
    expect(boxOf(b, "nada")).toBeUndefined();
  });
});
