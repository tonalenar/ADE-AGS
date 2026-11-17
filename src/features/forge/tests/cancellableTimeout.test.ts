import { afterEach, describe, expect, it, vi } from "vitest";

import { createCancellableTimeout } from "../cancellableTimeout";

describe("createCancellableTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("não dispara o tick depois de clear", () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const timer = createCancellableTimeout();
    timer.schedule(1000, () => ticks.push(1));
    timer.clear();
    vi.advanceTimersByTime(2000);
    expect(ticks).toEqual([]);
  });

  it("só o último schedule vale", () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const timer = createCancellableTimeout();
    timer.schedule(1000, () => ticks.push(1));
    timer.schedule(1000, () => ticks.push(2));
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([2]);
  });
});
