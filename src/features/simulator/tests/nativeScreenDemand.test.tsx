// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeScreen, type NativeScreenApi } from "../SimulatorScreen";

let root: Root | null = null;
let host: HTMLDivElement;

function api(): NativeScreenApi {
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    place: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
  };
}

function render(screen: NativeScreenApi, engaged: boolean) {
  act(() => {
    root ??= createRoot(host);
    root.render(<NativeScreen api={screen} screenId="tela" target="aparelho" radius={8} onError={() => {}} engaged={engaged} />);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.checkVisibility = () => false;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe("espelho nativo sob demanda", () => {
  it("não liga a sessão enquanto a superfície está fechada", () => {
    const screen = api();
    render(screen, false);
    expect(screen.attach).not.toHaveBeenCalled();
    expect(screen.detach).not.toHaveBeenCalled();
  });

  it("liga ao abrir e, ao esconder, não desmonta a sessão", async () => {
    const screen = api();
    render(screen, false);
    expect(screen.attach).not.toHaveBeenCalled();
    render(screen, true);
    expect(screen.attach).toHaveBeenCalledTimes(1);

    render(screen, false);
    await act(async () => { await Promise.resolve(); });
    expect(screen.detach).not.toHaveBeenCalled();
    expect(screen.attach).toHaveBeenCalledTimes(1);
  });
});
