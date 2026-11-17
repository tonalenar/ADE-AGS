// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeScreen, type NativeScreenApi } from "../SimulatorScreen";

// Os quadros são controlados pelo teste: cada `runFrame` roda o que foi pedido até então.
let frames: FrameRequestCallback[] = [];
function runFrame() {
  const queued = frames;
  frames = [];
  queued.forEach((callback) => callback(performance.now()));
}

const api: NativeScreenApi = {
  attach: vi.fn().mockResolvedValue(undefined),
  place: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn().mockResolvedValue(undefined),
} as unknown as NativeScreenApi;

let root: Root | null = null;
let host: HTMLDivElement;

describe("tela nativa aberta e parada", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    window.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return frames.length;
    };
    window.cancelAnimationFrame = () => {};
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  it("não mede a cada quadro quando nada mudou (antes, 60 medições por segundo por tela aberta)", async () => {
    act(() => {
      root = createRoot(host);
      root.render(<NativeScreen api={api} screenId="tela" target="udid" radius={8} onError={() => {}} />);
    });
    // A abertura (`attach`) resolve; depois, só quadros e nenhuma mutação do DOM.
    await act(async () => { await Promise.resolve(); });

    for (let i = 0; i < 60; i += 1) runFrame();

    expect(frames.length, "um quadro parado não pede outro quadro").toBe(0);
  });
});
