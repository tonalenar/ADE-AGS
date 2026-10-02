import { describe, expect, it } from "vitest";

import { addFolder, boxOf, emptyBoard, isFreeNodeId, removeFolder, updateFolder } from "../board";
import { baseName, flatten } from "../FolderNode";
import type { DirEntry } from "@/features/explorer/types";

const f = (path: string, extra: Partial<DirEntry> = {}): DirEntry => ({
  name: path.split("/").pop()!, path, isDir: false, isHidden: false, ...extra,
});

describe("carpetas", () => {
  it("se agrega, se actualiza y se quita; no es un agente", () => {
    let b = addFolder(emptyBoard(), { id: "folder-1", path: "C:/p/src", name: "src", at: { x: 10.4, y: 20.6 } });
    expect(b.folders["folder-1"]).toMatchObject({ path: "C:/p/src", name: "src", open: [], box: { x: 10, y: 21 } });
    expect(boxOf(b, "folder-1")).toBe(b.folders["folder-1"].box);
    expect(isFreeNodeId("folder-1")).toBe(true);
    b = updateFolder(b, "folder-1", { open: ["C:/p/src/a"] });
    expect(b.folders["folder-1"].open).toEqual(["C:/p/src/a"]);
    expect(updateFolder(b, "nada", { name: "x" })).toBe(b);
    b = removeFolder(b, "folder-1");
    expect(b.folders).toEqual({});
    expect(removeFolder(b, "folder-1")).toBe(b);
  });

  it("el nombre sale de la última carpeta, con cualquier barra", () => {
    expect(baseName("C:\\Users\\ana\\proyecto")).toBe("proyecto");
    expect(baseName("/home/ana/proyecto/")).toBe("proyecto");
    expect(baseName("C:\\Users\\ana\\proyecto\\")).toBe("proyecto");
    expect(baseName("/")).toBe("/");
  });
});

describe("el árbol aplanado", () => {
  const listing = {
    "/r": [f("/r/a", { isDir: true }), f("/r/b.txt"), f("/r/.env", { isHidden: true })],
    "/r/a": [f("/r/a/c.ts"), f("/r/a/d", { isDir: true })],
    "/r/a/d": [f("/r/a/d/e.ts")],
  };

  it("sin nada abierto muestra solo el primer nivel, sin ocultos", () => {
    const { rows } = flatten("/r", listing, new Set(), false);
    expect(rows.map((r) => r.entry.name)).toEqual(["a", "b.txt"]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it("una carpeta abierta mete sus hijos debajo, con su profundidad", () => {
    const { rows } = flatten("/r", listing, new Set(["/r/a", "/r/a/d"]), false);
    expect(rows.map((r) => `${r.depth}:${r.entry.name}`)).toEqual(["0:a", "1:c.ts", "1:d", "2:e.ts", "0:b.txt"]);
    expect(rows.find((r) => r.entry.name === "a")!.expanded).toBe(true);
  });

  it("los ocultos aparecen si se piden", () => {
    expect(flatten("/r", listing, new Set(), true).rows.map((r) => r.entry.name)).toContain(".env");
  });

  it("una carpeta abierta que todavía no se leyó no rompe nada", () => {
    expect(flatten("/r", listing, new Set(["/r/sin-leer"]), false).rows).toHaveLength(2);
    expect(flatten("/nada", {}, new Set(), false)).toEqual({ rows: [], truncated: false });
  });

  it("corta en el tope y lo avisa", () => {
    const many = { "/r": Array.from({ length: 50 }, (_, i) => f(`/r/f${i}`)) };
    const { rows, truncated } = flatten("/r", many, new Set(), false, 10);
    expect(rows).toHaveLength(10);
    expect(truncated).toBe(true);
    expect(flatten("/r", many, new Set(), false, 50).truncated).toBe(false);
  });
});
