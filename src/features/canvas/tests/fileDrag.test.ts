import { describe, expect, it } from "vitest";

import { hitTest, pathForTerminal } from "../fileDrag";

describe("ruta para la terminal", () => {
  it("una ruta simple va tal cual, con un espacio para seguir escribiendo", () => {
    expect(pathForTerminal("C:/p/src/a.ts")).toBe("C:/p/src/a.ts ");
    expect(pathForTerminal("/home/ana/a.ts")).toBe("/home/ana/a.ts ");
  });

  it("con espacios u otros caracteres de shell va entre comillas", () => {
    expect(pathForTerminal("C:/Mis Documentos/a b.ts")).toBe('"C:/Mis Documentos/a b.ts" ');
    expect(pathForTerminal("/p/a&b.ts")).toBe('"/p/a&b.ts" ');
    // Dentro de las comillas dobles se escapan las comillas, el $ y la tilde grave.
    const bs = String.fromCharCode(92);
    expect(pathForTerminal("/p/$HOME.ts")).toBe('"/p/' + bs + '$HOME.ts" ');
    expect(pathForTerminal('/p/dice "hola".ts')).toBe('"/p/dice ' + bs + '"hola' + bs + '".ts" ');
  });
});

describe("el agente bajo el puntero", () => {
  const r = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  const rects = [
    { id: "grande", rect: r(0, 0, 500, 500) },
    { id: "chico", rect: r(100, 100, 200, 200) },
    { id: "lejos", rect: r(600, 0, 700, 100) },
  ];

  it("encuentra el que contiene al punto, y el más chico si hay apilados", () => {
    expect(hitTest(rects, 150, 150)).toBe("chico");
    expect(hitTest(rects, 300, 300)).toBe("grande");
    expect(hitTest(rects, 650, 50)).toBe("lejos");
  });

  it("fuera de todos, nada", () => {
    expect(hitTest(rects, 550, 300)).toBeNull();
    expect(hitTest([], 1, 1)).toBeNull();
  });
});
