/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { armStartingTimeout } from "../DeviceNode";

describe("aviso de AVD iniciando", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("o timer de 20 s some no cleanup e não dispara depois", () => {
    const done = vi.fn();
    const stop = armStartingTimeout(done, 20_000);
    stop();
    vi.advanceTimersByTime(20_000);
    expect(done).not.toHaveBeenCalled();
  });

  it("sem cleanup o aviso apagaria depois de 20 s", () => {
    const done = vi.fn();
    armStartingTimeout(done, 20_000);
    vi.advanceTimersByTime(20_000);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
