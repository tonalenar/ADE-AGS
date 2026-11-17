// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sem cobertura de overlay nos testes: o que importa aqui é quando a medição roda e o que ela manda.
vi.mock("@/features/browser/nativeSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/browser/nativeSurface")>()),
  coversOf: () => [],
}));

import { NativeScreen, type NativeScreenApi } from "../SimulatorScreen";

// Os quadros são controlados pelo teste: cada `runFrame` roda o que foi pedido até então.
let frames: FrameRequestCallback[] = [];
function runFrame() {
  const queued = frames;
  frames = [];
  queued.forEach((callback) => callback(performance.now()));
}

const api = {
  attach: vi.fn().mockResolvedValue(undefined),
  place: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn().mockResolvedValue(undefined),
} as unknown as NativeScreenApi;

// A caixa que o elemento reporta: o teste a muda para simular a tela andando sem mutação do DOM (uma animação).
let box = { x: 40, y: 40, left: 40, top: 40, width: 200, height: 300, right: 240, bottom: 340, toJSON: () => ({}) };

let root: Root | null = null;
let host: HTMLDivElement;

function mount() {
  act(() => {
    root = createRoot(host);
    root.render(<NativeScreen api={api} screenId="tela" target="udid" radius={8} onError={() => {}} />);
  });
}

describe("tela nativa aberta e parada", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    window.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return frames.length;
    };
    window.cancelAnimationFrame = () => {};
    HTMLElement.prototype.getBoundingClientRect = () => box as DOMRect;
    HTMLElement.prototype.checkVisibility = () => true;
    vi.mocked(api.place).mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  it("não mede a cada quadro quando nada mudou (antes, 60 medições por segundo por tela aberta)", async () => {
    mount();
    // A abertura (`attach`) resolve; depois, só quadros e nenhuma mutação do DOM.
    await act(async () => { await Promise.resolve(); });

    for (let i = 0; i < 60; i += 1) runFrame();

    expect(frames.length, "um quadro parado não pede outro quadro").toBe(0);
  });

  it("o batimento de 250 ms manda a posição nova, e não manda quando nada mudou", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mount();
    await act(async () => { await Promise.resolve(); });

    // Depois da abertura, a medição vê a mesma posição que já foi mandada: nada a enviar.
    runFrame();
    expect(api.place).not.toHaveBeenCalled();

    // Um batimento sem nada novo: continua sem enviar.
    act(() => { vi.advanceTimersByTime(250); });
    runFrame();
    expect(api.place).not.toHaveBeenCalled();

    // A tela andou sem mutação do DOM: o batimento pega a posição nova e manda uma vez.
    box = { ...box, x: 90, left: 90, right: 290 };
    act(() => { vi.advanceTimersByTime(250); });
    runFrame();
    expect(api.place).toHaveBeenCalledTimes(1);

    // Parada de novo: não repete o envio da mesma posição.
    act(() => { vi.advanceTimersByTime(250); });
    runFrame();
    expect(api.place).toHaveBeenCalledTimes(1);
  });
});
