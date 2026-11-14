// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFleetClock } from "../fleetClock";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");

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
  if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
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

  it("pausa ao ocultar a janela e retoma um único timer quando ela volta", async () => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    let renders = 0;
    await act(async () => root?.render(<ClockProbe onRender={() => { renders += 1; }} />));
    expect(vi.getTimerCount()).toBe(1);
    const initialRenders = renders;

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(renders).toBe(initialRenders);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(renders).toBe(initialRenders + 1);
  });
});
