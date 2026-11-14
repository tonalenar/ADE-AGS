// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFleetClock } from "../fleetClock";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function ClockProbe({ onRender }: { onRender: () => void }) {
  useFleetClock(true);
  onRender();
  return null;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.useRealTimers();
});

describe("relógio compartilhado da frota", () => {
  it("mantém um timer para vários cartões e encerra quando todos saem", async () => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    let renders = 0;

    await act(async () => root?.render(<>{Array.from({ length: 12 }, (_, i) => <ClockProbe key={i} onRender={() => { renders += 1; }} />)}</>));
    expect(vi.getTimerCount()).toBe(1);
    expect(renders).toBe(12);

    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(renders).toBe(24);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});
