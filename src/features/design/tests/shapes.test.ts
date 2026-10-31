import { describe, expect, it } from "vitest";

import { resizeFromCorner } from "../snap";
import { arrowHead, fillClass, normalizeStroke, parseShapeData, polylinePath, resizeShape, shapeBox, strokeClass, thinPoints, type Shape } from "../shapes";

const shape = (o: Partial<Shape>): Shape => ({ id: "s", kind: "rect", x: 0, y: 0, w: 10, h: 10, data: parseShapeData({}), ...o });

describe("formas", () => {
  it("lê data de objeto ou JSON, com padrões e sem aceitar cor solta", () => {
    expect(parseShapeData(null)).toEqual({ stroke: "black", fill: null, width: 2, points: [], text: "", size: 24 });
    expect(parseShapeData('{"stroke":"red","width":99,"fill":"blue"}')).toMatchObject({ stroke: "red", width: 24, fill: "blue" });
    expect(parseShapeData({ stroke: "#ff0000", fill: "url(x)" })).toMatchObject({ stroke: "black", fill: null });
    expect(parseShapeData("não é json").stroke).toBe("black");
    expect(parseShapeData({ points: [[0.5, 2], [1], ["a", 1], [0, 0]] }).points).toEqual([[0.5, 1], [0, 0]]);
  });

  it("caixa normalizada de linha com sinal e redimensionar mantendo o sentido", () => {
    const line = shape({ kind: "line", x: 100, y: 50, w: -40, h: 20 });
    expect(shapeBox(line)).toEqual({ x: 60, y: 50, w: 40, h: 20 });
    expect(resizeShape(line, { x: 60, y: 50, w: 80, h: 20 })).toEqual({ x: 140, y: 50, w: -80, h: 20 });
    expect(resizeShape(shape({}), { x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("traço do lápis: caixa + pontos relativos, e pontos ralos", () => {
    const { box, points } = normalizeStroke([{ x: 10, y: 10 }, { x: 30, y: 20 }, { x: 20, y: 10 }]);
    expect(box).toEqual({ x: 10, y: 10, w: 20, h: 10 });
    expect(points).toEqual([[0, 0], [1, 1], [0.5, 0]]);
    expect(normalizeStroke([{ x: 5, y: 5 }]).box).toEqual({ x: 5, y: 5, w: 1, h: 1 });
    expect(thinPoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 6, y: 0 }], 3)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 6, y: 0 }]);
    expect(polylinePath([[0, 0], [1, 0.5]], 100, 40)).toBe("M0 0 L100 20");
    expect(polylinePath([], 1, 1)).toBe("");
  });

  it("ponta da seta no fim da linha e classes sem hex", () => {
    const [tip, a, b] = arrowHead(0, 0, 100, 0, 10);
    expect(tip).toEqual([100, 0]);
    expect(a[0]).toBeLessThan(100);
    expect(a[1]).toBeCloseTo(-b[1]);
    expect(strokeClass("blue")).toBe("stroke-sky-500");
    expect(fillClass(null)).toBe("fill-transparent");
  });

  it("formas redimensionam abaixo do mínimo das pranchetas", () => {
    expect(resizeFromCorner({ x: 0, y: 0, w: 50, h: 50 }, "se", -45, -45, { snap: false, min: 4 })).toMatchObject({ w: 5, h: 5 });
  });
});
