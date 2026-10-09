import { describe, expect, it } from "vitest";

import {
  addEdge, addNote, boxOf, bringToFront, defaultNoteName, emptyBoard, isHiddenNote, reconcile, removeNote, setNoteBox, shownNote, stackInto,
  stackMembers, uniqueNoteName, unstack, updateNote,
} from "../board";

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

describe("pilas de notas", () => {
  const base = () => {
    let b = emptyBoard();
    for (const [id, name] of [["note-a", "A"], ["note-b", "B"], ["note-c", "C"]] as const) {
      b = addNote(b, { id, name, content: name, at: { x: id === "note-a" ? 0 : id === "note-b" ? 400 : 800, y: 0 } }).board;
    }
    return b;
  };

  it("apilar pone la nota en la caja de la otra, al frente, y la tapada no se dibuja", () => {
    const b = stackInto(base(), "note-b", "note-a");
    expect(b.notes["note-b"].box).toEqual(b.notes["note-a"].box);
    expect(b.notes["note-b"]).toMatchObject({ stack: "note-a", front: true });
    expect(b.notes["note-a"]).toMatchObject({ stack: "note-a", front: false });
    expect(isHiddenNote(b, "note-a")).toBe(true);
    expect(isHiddenNote(b, "note-b")).toBe(false);
    expect(isHiddenNote(b, "note-c")).toBe(false);
    expect(stackMembers(b, "note-a")).toEqual(["note-a", "note-b"]);
    expect(shownNote(b, "note-a")).toBe("note-b");
  });

  it("una tercera se suma a la pila y pasa al frente; traer al frente cambia cuál se ve", () => {
    let b = stackInto(stackInto(base(), "note-b", "note-a"), "note-c", "note-b");
    expect(stackMembers(b, "note-a")).toEqual(["note-a", "note-b", "note-c"]);
    expect(b.notes["note-c"].front).toBe(true);
    expect(b.notes["note-b"].front).toBe(false);
    b = bringToFront(b, "note-a");
    expect(shownNote(b, "note-c")).toBe("note-a");
    expect(isHiddenNote(b, "note-c")).toBe(true);
    expect(bringToFront(b, "note-a")).toBe(b);
  });

  it("mover o redimensionar una nota mueve toda su pila", () => {
    let b = stackInto(base(), "note-b", "note-a");
    b = setNoteBox(b, "note-b", { x: 50, y: 60 });
    expect(b.notes["note-a"].box).toMatchObject({ x: 50, y: 60 });
    expect(b.notes["note-b"].box).toMatchObject({ x: 50, y: 60 });
    expect(b.notes["note-c"].box.x).toBe(800);
  });

  it("soltar una nota la corre; con una sola en la pila, la pila se disuelve", () => {
    const stacked = stackInto(base(), "note-b", "note-a");
    const b = unstack(stacked, "note-b");
    expect(b.notes["note-b"].stack).toBeUndefined();
    expect(b.notes["note-b"].box.x).toBe(stacked.notes["note-a"].box.x + 40);
    expect(b.notes["note-a"].stack).toBeUndefined();
    expect(isHiddenNote(b, "note-a")).toBe(false);
  });

  it("quitar la del frente pasa otra al frente; con dos, al quitar una queda suelta la otra", () => {
    const three = stackInto(stackInto(base(), "note-b", "note-a"), "note-c", "note-b");
    const b = removeNote(three, "note-c");
    expect(stackMembers(b, "note-a")).toEqual(["note-a", "note-b"]);
    expect(b.notes["note-a"].front || b.notes["note-b"].front).toBe(true);
    const c = removeNote(b, b.notes["note-a"].front ? "note-a" : "note-b");
    expect(Object.values(c.notes).every((n) => n.stack === undefined)).toBe(true);
  });

  it("una nota que se mueve de pila deja a la anterior bien, y crear con stackWith la mete en la pila", () => {
    let b = stackInto(stackInto(base(), "note-b", "note-a"), "note-c", "note-a");
    b = stackInto(b, "note-c", "note-b");
    expect(stackMembers(b, "note-a").sort()).toEqual(["note-a", "note-b", "note-c"]);
    const created = addNote(base(), { id: "note-d", name: "D", content: "", stackWith: "note-a" }).board;
    expect(created.notes["note-d"]).toMatchObject({ stack: "note-a", front: true });
    expect(stackInto(created, "note-a", "note-a")).toBe(created);
  });
});

describe("reconcile não derruba a ligação de uma aba que segue aberta (AGS-014)", () => {
  it("uma aba aberta em outro piso mantém a aresta com o orquestrador", () => {
    const board = addEdge(reconcile(emptyBoard(), ["lead", "backend"]), "lead", "backend");
    // O canvas deste piso já não tem "backend" entre as suas, mas a aba segue aberta.
    const next = reconcile(board, ["lead"], ["lead", "backend"]);
    expect(next.edges.some((e) => (e.a === "lead" && e.b === "backend") || (e.a === "backend" && e.b === "lead"))).toBe(true);
  });
  it("uma aba fechada perde a ligação, como antes", () => {
    const board = addEdge(reconcile(emptyBoard(), ["lead", "backend"]), "lead", "backend");
    const next = reconcile(board, ["lead"], ["lead"]);
    expect(next.edges.some((e) => e.a === "backend" || e.b === "backend")).toBe(false);
  });
});
