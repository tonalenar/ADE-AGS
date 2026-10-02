import { describe, expect, it } from "vitest";

import { addEdge, addNote, addPortal, boxOf, emptyBoard, reconcile, removePortal, uniquePortalName, updatePortal } from "../board";

describe("portales", () => {
  it("un portal creado cerca de un agente queda conectado y a su derecha", () => {
    const base = reconcile(emptyBoard(), ["t1"]);
    const { board, name } = addPortal(base, { id: "portal-1", near: "t1", url: "http://localhost:3000" });
    expect(name).toBe("Portal");
    expect(board.portals["portal-1"].url).toBe("http://localhost:3000");
    expect(board.edges).toEqual([expect.objectContaining({ a: "t1", b: "portal-1" })]);
    const agent = board.nodes.t1;
    expect(board.portals["portal-1"].box.x).toBeGreaterThanOrEqual(agent.x + agent.w);
  });

  it("un portal y una nota junto al mismo agente no se pisan", () => {
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addNote(b, { id: "note-1", content: "x", near: "t1" }).board;
    b = addPortal(b, { id: "portal-1", near: "t1" }).board;
    const [n, p] = [b.notes["note-1"].box, b.portals["portal-1"].box];
    const overlap = n.x < p.x + p.w && p.x < n.x + n.w && n.y < p.y + p.h && p.y < n.y + n.h;
    expect(overlap).toBe(false);
  });

  it("los nombres repetidos se desambiguan", () => {
    let b = addPortal(emptyBoard(), { id: "portal-1", name: "Docs" }).board;
    expect(addPortal(b, { id: "portal-2", name: "docs" }).name).toBe("docs 2");
    b = addPortal(b, { id: "portal-2", name: "App" }).board;
    expect(updatePortal(b, "portal-2", { name: "Docs" }).portals["portal-2"].name).toBe("Docs 2");
    expect(uniquePortalName(b, "Docs", "portal-1")).toBe("Docs");
  });

  it("cerrar tabs no se lleva los portales; borrarlos se lleva sus conexiones", () => {
    let b = reconcile(emptyBoard(), ["t1"]);
    b = addPortal(b, { id: "portal-1", near: "t1" }).board;
    b = addPortal(b, { id: "portal-2" }).board;
    b = addEdge(b, "portal-1", "portal-2", "e2");
    b = reconcile(b, []);
    expect(Object.keys(b.portals)).toEqual(["portal-1", "portal-2"]);
    expect(b.edges.map((e) => e.id)).toEqual(["e2"]);
    b = removePortal(b, "portal-1");
    expect(b.edges).toEqual([]);
    expect(boxOf(b, "portal-1")).toBeUndefined();
    expect(boxOf(b, "portal-2")).toBeDefined();
  });
});
