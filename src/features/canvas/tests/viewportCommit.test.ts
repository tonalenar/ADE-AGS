import { describe, expect, it } from "vitest";

import { LIVE_MIN_ZOOM } from "../geometry";
import { desktopRectsOf, liveRectsOf, viewportNeedsRender } from "../viewportCommit";

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

  it("o overlay Gemini muda com o pan no mesmo viewport dos liveRects", () => {
    const start = { x: 40, y: 40, zoom: 1 };
    const panned = { x: 80, y: 40, zoom: 1 };
    expect(viewportNeedsRender(start, panned)).toBe(false);
    const portals = [{ id: "g", box: { x: 0, y: 0, w: 1000, h: 700 } }];
    const size = { width: 1400, height: 900 };
    const before = desktopRectsOf(portals, start, size);
    const after = desktopRectsOf(portals, panned, size);
    expect(before.g).toBeDefined();
    expect(after.g).toBeDefined();
    expect(after.g!.left).not.toBe(before.g!.left);
    expect(after.g!.left - before.g!.left).toBe(40);
  });
});
