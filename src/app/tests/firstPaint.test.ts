import { afterEach, describe, expect, it, vi } from "vitest";

import { whenHomeCanPaint } from "@/app/bootGate";
import { createFitter } from "@/features/terminal/fit";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("primeira tela", () => {
  it("a home pinta antes da fonte e o terminal só mede depois de fontsReady", async () => {
    let releaseFont: () => void = () => {};
    const fontsReady = new Promise<void>((resolve) => {
      releaseFont = resolve;
    });
    const order: string[] = [];

    const painted = whenHomeCanPaint({
      loadAgentRegistry: async () => {
        order.push("registry");
      },
      applyRendering: async () => {
        order.push("rendering");
      },
      fontsReady,
    }).then(() => {
      order.push("home");
    });

    await painted;
    expect(order).toEqual(["registry", "rendering", "home"]);

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    let fits = 0;
    const addon = {
      fit: () => {
        fits += 1;
        order.push("measure");
      },
    };
    const term = { cols: 80, rows: 24, resize: () => {}, options: {} };
    const { fitOnce } = createFitter(
      term as never,
      addon as never,
      () => null,
      fontsReady,
    );
    const measuring = fitOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(fits).toBe(0);
    expect(order).not.toContain("measure");

    releaseFont();
    await measuring;
    expect(fits).toBe(1);
    expect(order.indexOf("home")).toBeLessThan(order.indexOf("measure"));
  });
});
