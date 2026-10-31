import { describe, expect, it } from "vitest";

import {
  boardFitBox, canZoomIn, canZoomOut, clampScale, cubicBezier, fitCamera, glideDuration, lerpCamera, liveBoards,
  normalizeWheel, panBy, presetOf, readCamera, stepZoom, toScreen, toWorld, unionBox, wheelCamera, writeCamera, zoomAt, zoomReadout,
  type Camera,
} from "../camera";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const wheel = (o: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean }>) =>
  ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...o });

describe("câmera", () => {
  it("converte mundo ↔ tela", () => {
    const cam: Camera = { x: 100, y: 50, scale: 2 };
    expect(toScreen(cam, 110, 60)).toEqual({ x: 20, y: 20 });
    expect(toWorld(cam, 20, 20)).toEqual({ x: 110, y: 60 });
  });

  it("zoom no cursor mantém parado o ponto sob ele e respeita 1%–800%", () => {
    const cam: Camera = { x: 0, y: 0, scale: 1 };
    const z = zoomAt(cam, 2, 300, 200);
    expect(toWorld(z, 300, 200)).toEqual(toWorld(cam, 300, 200));
    expect(zoomAt(cam, 100, 0, 0).scale).toBe(8);
    expect(zoomAt(cam, 0.0001, 0, 0).scale).toBe(0.01);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it("roda sem modificador faz pan; Ctrl/⌘ faz zoom com passo limitado a ln 1,25", () => {
    const cam: Camera = { x: 0, y: 0, scale: 2 };
    expect(wheelCamera(cam, wheel({ deltaX: 10, deltaY: 20 }), 0, 0, 800)).toEqual({ x: 5, y: 10, scale: 2 });
    expect(wheelCamera(cam, wheel({ deltaY: -10000, ctrlKey: true }), 0, 0, 800).scale).toBeCloseTo(2.5);
    expect(wheelCamera(cam, wheel({ deltaY: 10, metaKey: true }), 0, 0, 800).scale).toBeCloseTo(2 * Math.exp(-0.1));
  });

  it("normaliza deltaMode linha (16 px) e página (altura)", () => {
    expect(normalizeWheel({ deltaX: 1, deltaY: 2, deltaMode: 1 }, 700)).toEqual({ dx: 16, dy: 32 });
    expect(normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 700)).toEqual({ dx: 0, dy: 700 });
  });

  it("pan arrasta o conteúdo junto com o ponteiro", () => {
    expect(panBy({ x: 0, y: 0, scale: 2 }, 20, -10)).toEqual({ x: -10, y: 5, scale: 2 });
  });

  it("passos ×1,25 e ×0,8, leitura inteira mínima 1, presets e limites", () => {
    expect(stepZoom({ x: 0, y: 0, scale: 1 }, 1, 800, 600).scale).toBeCloseTo(1.25);
    expect(stepZoom({ x: 0, y: 0, scale: 1 }, -1, 800, 600).scale).toBeCloseTo(0.8);
    expect(zoomReadout(0.001)).toBe(1);
    expect(zoomReadout(0.756)).toBe(76);
    expect(presetOf(0.5)).toBe(0.5);
    expect(presetOf(0.6)).toBeNull();
    expect(canZoomIn(8)).toBe(false);
    expect(canZoomOut(0.01)).toBe(false);
  });

  it("enquadra com margem de 48 px, centraliza e nunca passa de 200%", () => {
    const box = { x: 0, y: 0, w: 400, h: 300 };
    const small = fitCamera(box, 2000, 2000);
    expect(small.scale).toBe(2);
    const cam = fitCamera({ x: 0, y: 0, w: 1000, h: 500 }, 1096, 900);
    expect(cam.scale).toBeCloseTo(1);
    // centro da caixa no centro da vista
    expect(toScreen(cam, 500, 250)).toEqual({ x: 548, y: 450 });
    expect(fitCamera(null, 100, 100)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("uma prancheta sozinha reserva 40 px acima para o título", () => {
    expect(boardFitBox({ x: 10, y: 100, w: 50, h: 60 })).toEqual({ x: 10, y: 60, w: 50, h: 100 });
    expect(unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 5, h: 5 }])).toEqual({ x: 0, y: -5, w: 25, h: 15 });
    expect(unionBox([])).toBeNull();
  });

  it("glide: 300–900 ms por 18·√d, 0 parado ou com movimento reduzido", () => {
    const a: Camera = { x: 0, y: 0, scale: 1 };
    expect(glideDuration(a, a, 800, 600)).toBe(0);
    expect(glideDuration(a, { x: 10, y: 0, scale: 1 }, 800, 600)).toBe(300);
    expect(glideDuration(a, { x: 1e6, y: 0, scale: 1 }, 800, 600)).toBe(900);
    expect(glideDuration(a, { x: 1e6, y: 0, scale: 1 }, 800, 600, true)).toBe(0);
    const b: Camera = { x: 500, y: 200, scale: 4 };
    expect(lerpCamera(a, b, 0, 800, 600)).toEqual(a);
    const end = lerpCamera(a, b, 1, 800, 600);
    expect(end.x).toBeCloseTo(500);
    expect(end.scale).toBeCloseTo(4);
  });

  it("a curva cúbica vai de 0 a 1 e é monótona", () => {
    const ease = cubicBezier(0.165, 0.84, 0.44, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.5);
    expect(ease(0.3)).toBeLessThan(ease(0.6));
  });

  it("lembra a câmera por página e recusa lixo, outra página ou escala fora do limite", () => {
    const s = memory();
    writeCamera(s, "d1", "p1", { x: 1, y: 2, scale: 0.5 });
    expect(readCamera(s, "d1", "p1")).toEqual({ x: 1, y: 2, scale: 0.5 });
    expect(readCamera(s, "d1", "p2")).toBeNull();
    s.setItem("design-view/d1/p1", "{lixo");
    expect(readCamera(s, "d1", "p1")).toBeNull();
    s.setItem("design-view/d1/p1", JSON.stringify({ page: "p1", x: 0, y: 0, scale: 50 }));
    expect(readCamera(s, "d1", "p1")).toBeNull();
    expect(readCamera(null, "d1", "p1")).toBeNull();
  });

  it("monta o iframe só perto da vista, do centro para fora, dentro do orçamento", () => {
    const cam: Camera = { x: 0, y: 0, scale: 1 };
    const boards = [
      { id: "a", x: 0, y: 0, w: 400, h: 300 },
      { id: "b", x: 450, y: 0, w: 400, h: 300 },
      { id: "far", x: 50000, y: 0, w: 400, h: 300 },
    ];
    expect([...liveBoards(boards, cam, 1000, 800)].sort()).toEqual(["a", "b"]);
    expect([...liveBoards(boards, cam, 1000, 800, { budget: 1 })]).toHaveLength(1);
    expect(liveBoards(boards, cam, 1000, 800, { pinned: new Set(["far"]) }).has("far")).toBe(true);
  });
});
