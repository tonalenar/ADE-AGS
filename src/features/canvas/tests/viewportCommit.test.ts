import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LIVE_MIN_ZOOM } from "../geometry";
import { liveRectsOf, viewportNeedsRender } from "../viewportCommit";

const VIEW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../CanvasView.tsx");

describe("pan/zoom sem re-render do canvas", () => {
  it("um pan no mesmo zoom não pede estado React", () => {
    const prev = { x: 0, y: 0, zoom: 1 };
    expect(viewportNeedsRender(prev, { x: 40, y: -12, zoom: 1 })).toBe(false);
  });

  it("cruzar o limiar ao vivo pede estado React", () => {
    expect(viewportNeedsRender({ x: 0, y: 0, zoom: LIVE_MIN_ZOOM }, { x: 0, y: 0, zoom: LIVE_MIN_ZOOM - 0.05 })).toBe(true);
  });

  it("só inclui na tela os nós que intersectam a área", () => {
    const rects = liveRectsOf(
      [{ id: "in", box: { x: 0, y: 0, w: 600, h: 400 } }, { id: "out", box: { x: 9000, y: 0, w: 600, h: 400 } }],
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600 },
    );
    expect(Object.keys(rects)).toEqual(["in"]);
  });

  it("o pan não grava o viewport no estado React a cada quadro", () => {
    const src = readFileSync(VIEW, "utf8");
    expect(src).toContain("viewportNeedsRender");
    expect(src).toContain("liveRectsOf");
    expect(src).not.toMatch(/onViewportChange=\{setVp\}/);
  });
});
