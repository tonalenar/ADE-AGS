/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteModal } from "../../app/RouteModal";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

function esc(target: Element) {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(ev); });
  return ev;
}

describe("RouteModal Escape", () => {
  it("fecha a tela com o foco num campo de texto comum", () => {
    const onClose = vi.fn();
    act(() => root.render(<MemoryRouter><RouteModal onClose={onClose}><input aria-label="q" /></RouteModal></MemoryRouter>));
    const input = host.querySelector("input")!;
    input.focus();
    esc(input);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("não fecha a tela quando o controle focado tem o popup aberto (aria-expanded)", () => {
    const onClose = vi.fn();
    act(() => root.render(<MemoryRouter><RouteModal onClose={onClose}><input role="combobox" aria-expanded="true" aria-label="q" /></RouteModal></MemoryRouter>));
    const input = host.querySelector("input")!;
    input.focus();
    const ev = esc(input);
    expect(onClose).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("não fecha a tela com o foco numa opção do popup aberto", () => {
    const onClose = vi.fn();
    act(() => root.render(<MemoryRouter><RouteModal onClose={onClose}>
      <button aria-haspopup="listbox" aria-expanded="true">escolher</button>
      <div role="listbox"><button role="option" aria-selected="false">um</button></div>
    </RouteModal></MemoryRouter>));
    const option = host.querySelector("[role=option]") as HTMLElement;
    option.focus();
    const ev = esc(option);
    expect(onClose).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("fecha a tela com o foco numa lista fixa, sem nenhum popup aberto", () => {
    const onClose = vi.fn();
    act(() => root.render(<MemoryRouter><RouteModal onClose={onClose}>
      <div role="listbox"><button role="option" aria-selected="false">um</button></div>
    </RouteModal></MemoryRouter>));
    const option = host.querySelector("[role=option]") as HTMLElement;
    option.focus();
    esc(option);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
