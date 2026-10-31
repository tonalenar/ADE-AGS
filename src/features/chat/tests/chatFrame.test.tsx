// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatFrame } from "../ChatFrame";
import { COMPOSER_CLEARANCE, COMPOSER_FADE } from "../composerLayout";

class FakeObserver {
  constructor(private cb: () => void) {}
  observe() { this.cb(); }
  disconnect() { /* nada */ }
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FakeObserver });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); });

const mount = (height: number) => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => height });
  const seen: number[] = [];
  return act(async () => {
    root.render(<ChatFrame composer={<div data-testid="composer">c</div>} list={(inset) => { seen.push(inset); return <div data-testid="lista" data-inset={inset} />; }} />);
  }).then(() => seen);
};

describe("o composer flutua por cima da lista", () => {
  it("a lista recebe como espaço no fim a altura medida do composer mais o vão", async () => {
    await mount(180);
    expect((host.querySelector("[data-testid=lista]") as HTMLElement).dataset.inset).toBe(String(180 + COMPOSER_CLEARANCE));
  });

  it("o composer é um bloco sobreposto (absoluto, colado ao fundo) com fundo sólido e o degradê no alto", async () => {
    await mount(180);
    const overlay = host.querySelector("[data-testid=composer]")!.parentElement!.parentElement as HTMLElement;
    expect(overlay.className).toContain("absolute");
    expect(overlay.className).toContain("bottom-0");
    const solid = host.querySelector("[data-testid=composer]")!.parentElement as HTMLElement;
    expect(solid.className).toContain("bg-white");
    expect(solid.className).toContain("dark:bg-surface-deep");
    const fade = overlay.firstElementChild as HTMLElement;
    expect(fade.className).toContain("bg-gradient-to-t");
    expect(fade.style.height).toBe(`${COMPOSER_FADE}px`);
    // O degradê deixa a barra de rolagem livre à direita.
    expect(fade.className).toContain("mr-3.5");
  });

  it("só o cartão pega o clique: a faixa do degradê deixa passar (a lista continua rolando por baixo)", async () => {
    await mount(180);
    const overlay = host.querySelector("[data-testid=composer]")!.parentElement!.parentElement as HTMLElement;
    expect(overlay.className).toContain("pointer-events-none");
    expect((host.querySelector("[data-testid=composer]")!.parentElement as HTMLElement).className).toContain("pointer-events-auto");
  });
});
