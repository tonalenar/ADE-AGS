import { describe, expect, it } from "vitest";

import { shareMissionFetch } from "../arcadeDataCache";
import { canvasBufferSize, needsCanvasResize } from "../canvasSize";

describe("A520 canvas", () => {
  it("não pede resize se o buffer já tem o tamanho", () => {
    const next = canvasBufferSize(100, 50, 2);
    expect(next).toEqual({ w: 200, h: 100 });
    expect(needsCanvasResize({ width: 200, height: 100 }, next)).toBe(false);
    expect(needsCanvasResize({ width: 1, height: 1 }, next)).toBe(true);
  });
});

describe("A522 cache da grade", () => {
  it("reusa a Promise da mesma missão", async () => {
    let n = 0;
    const a = shareMissionFetch("m1", "t", async () => { n += 1; return 1; });
    const b = shareMissionFetch("m1", "t", async () => { n += 1; return 2; });
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(n).toBe(1);
  });
});
