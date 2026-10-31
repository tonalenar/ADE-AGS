import type { Box } from "./camera";

/**
 * As formas desenhadas no canvas (F4): retângulo, oval, linha, seta, lápis, caneta e texto. Gravadas
 * em `design_shape` com `data` em JSON. Puro.
 *
 * Convenções de `data`:
 * - `stroke`/`fill`: nome de cor da paleta (nunca hex nem CSS solto: o que vem do banco não é confiável);
 * - `width`: espessura do traço em px de mundo (1–24);
 * - `points`: no lápis e na caneta, pontos RELATIVOS à caixa (0–1), assim redimensionar só muda w/h;
 * - `text` e `size` (px) no texto.
 * Linha e seta usam a caixa com sinal: de (x, y) até (x + w, y + h).
 */
export type ShapeKind = "rect" | "oval" | "line" | "arrow" | "pencil" | "pen" | "text";
export const SHAPE_KINDS: ShapeKind[] = ["rect", "oval", "line", "arrow", "pencil", "pen", "text"];
export const SHAPE_COLORS = ["black", "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type ShapeColor = (typeof SHAPE_COLORS)[number];

export interface ShapeData {
  stroke: ShapeColor;
  fill: ShapeColor | null;
  width: number;
  points: Array<[number, number]>;
  text: string;
  size: number;
}
export interface Shape { id: string; kind: ShapeKind; x: number; y: number; w: number; h: number; data: ShapeData }

/** Tamanhos de criação por clique (sem arrastar). */
export const CLICK_SIZE: Record<"rect" | "oval" | "line" | "arrow" | "text", { w: number; h: number }> = {
  rect: { w: 120, h: 120 }, oval: { w: 96, h: 96 }, line: { w: 160, h: 0 }, arrow: { w: 160, h: 0 }, text: { w: 240, h: 40 },
};
export const WIDTH_RANGE = { min: 1, max: 24 } as const;

const isColor = (v: unknown): v is ShapeColor => typeof v === "string" && (SHAPE_COLORS as readonly string[]).includes(v);
const clampNum = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Lê `data` (objeto ou string JSON, do banco) com padrões seguros para cada campo. */
export function parseShapeData(raw: unknown): ShapeData {
  let d: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try { d = JSON.parse(raw) as Record<string, unknown>; } catch { d = {}; }
  } else if (raw && typeof raw === "object") d = raw as Record<string, unknown>;
  if (!d || typeof d !== "object") d = {};
  const points = Array.isArray(d.points)
    ? d.points.slice(0, 2000).flatMap((p) => (Array.isArray(p) && p.length >= 2 && p.every((n) => typeof n === "number" && Number.isFinite(n))
      ? [[clampNum(p[0], 0, 1, 0), clampNum(p[1], 0, 1, 0)] as [number, number]] : []))
    : [];
  return {
    stroke: isColor(d.stroke) ? d.stroke : "black",
    fill: isColor(d.fill) ? d.fill : null,
    width: clampNum(d.width, WIDTH_RANGE.min, WIDTH_RANGE.max, 2),
    points,
    text: typeof d.text === "string" ? d.text.slice(0, 5000) : "",
    size: clampNum(d.size, 8, 200, 24),
  };
}

export const isShapeKind = (k: unknown): k is ShapeKind => typeof k === "string" && (SHAPE_KINDS as string[]).includes(k);

/** A caixa normalizada (largura e altura positivas) de qualquer forma, para seleção e enquadrar. */
export function shapeBox(s: Pick<Shape, "x" | "y" | "w" | "h">): Box {
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}

/** Pontos absolutos (mundo) → caixa + pontos relativos 0–1. Uma dimensão zero vira 1 para não dividir por 0. */
export function normalizeStroke(points: Array<{ x: number; y: number }>): { box: Box; points: Array<[number, number]> } {
  if (points.length === 0) return { box: { x: 0, y: 0, w: 1, h: 1 }, points: [] };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x);
  const h = Math.max(1, Math.max(...ys) - y);
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { box: { x, y, w, h }, points: points.map((p) => [r((p.x - x) / w), r((p.y - y) / h)]) };
}

/** Diminui os pontos do lápis: descarta os que ficam a menos de `min` px do último guardado. */
export function thinPoints(points: Array<{ x: number; y: number }>, min: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= min) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end && out.length > 0) out.push(end);
  return out;
}

/** O `d` de um caminho por pontos relativos dentro de uma caixa w×h (local, origem no canto). */
export function polylinePath(points: Array<[number, number]>, w: number, h: number, closed = false): string {
  if (points.length === 0) return "";
  const p = points.map(([fx, fy]) => `${round(fx * w)} ${round(fy * h)}`);
  return `M${p[0]}${p.slice(1).map((q) => ` L${q}`).join("")}${closed ? " Z" : ""}`;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** A ponta da seta em (x2, y2), apontando de (x1, y1): os três vértices do triângulo. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number): Array<[number, number]> {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [round(x2), round(y2)],
    [round(x2 - size * Math.cos(a - spread)), round(y2 - size * Math.sin(a - spread))],
    [round(x2 - size * Math.cos(a + spread)), round(y2 - size * Math.sin(a + spread))],
  ];
}

/** Classes do Tailwind por cor (sem hex): traço e preenchimento. Mapa estático para o Tailwind gerar. */
const STROKE: Record<ShapeColor, string> = {
  black: "stroke-gray-900", gray: "stroke-gray-500", red: "stroke-red-500", orange: "stroke-orange-500", yellow: "stroke-amber-400",
  green: "stroke-green-500", teal: "stroke-teal-500", blue: "stroke-sky-500", purple: "stroke-purple-500", pink: "stroke-pink-500",
};
const FILL: Record<ShapeColor, string> = {
  black: "fill-gray-900", gray: "fill-gray-300", red: "fill-red-200", orange: "fill-orange-200", yellow: "fill-amber-200",
  green: "fill-green-200", teal: "fill-teal-200", blue: "fill-sky-200", purple: "fill-purple-200", pink: "fill-pink-200",
};
const TEXT: Record<ShapeColor, string> = {
  black: "text-gray-900", gray: "text-gray-500", red: "text-red-600", orange: "text-orange-600", yellow: "text-amber-500",
  green: "text-green-600", teal: "text-teal-600", blue: "text-sky-600", purple: "text-purple-600", pink: "text-pink-600",
};
const SWATCH: Record<ShapeColor, string> = {
  black: "bg-gray-900", gray: "bg-gray-500", red: "bg-red-500", orange: "bg-orange-500", yellow: "bg-amber-400",
  green: "bg-green-500", teal: "bg-teal-500", blue: "bg-sky-500", purple: "bg-purple-500", pink: "bg-pink-500",
};
const HEAD: Record<ShapeColor, string> = {
  black: "fill-gray-900", gray: "fill-gray-500", red: "fill-red-500", orange: "fill-orange-500", yellow: "fill-amber-400",
  green: "fill-green-500", teal: "fill-teal-500", blue: "fill-sky-500", purple: "fill-purple-500", pink: "fill-pink-500",
};
export const strokeClass = (c: ShapeColor) => STROKE[c];
/** A ponta da seta: cheia, na cor do traço. */
export const headClass = (c: ShapeColor) => HEAD[c];
export const fillClass = (c: ShapeColor | null) => (c ? FILL[c] : "fill-transparent");
export const textClass = (c: ShapeColor) => TEXT[c];
export const swatchClass = (c: ShapeColor) => SWATCH[c];

/** Redimensiona uma forma para a caixa nova. Linha e seta mantêm o sentido (sinal de w/h). */
export function resizeShape(s: Shape, box: Box): Pick<Shape, "x" | "y" | "w" | "h"> {
  if (s.kind === "line" || s.kind === "arrow") {
    const sx = s.w < 0 ? -1 : 1;
    const sy = s.h < 0 ? -1 : 1;
    return { x: sx < 0 ? box.x + box.w : box.x, y: sy < 0 ? box.y + box.h : box.y, w: sx * box.w, h: sy * box.h };
  }
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}
