// @vitest-environment happy-dom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { positionAnchoredPopover, useAnchoredPopover } from "@/features/chat/anchoredPopover";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Example() {
  const { open, setOpen, triggerRef, panelRef, style } = useAnchoredPopover();
  return (
    <>
      <button ref={triggerRef} data-trigger type="button" onClick={() => setOpen(!open)}>Configurações</button>
      {open && createPortal(
        <section ref={panelRef} data-panel role="dialog" tabIndex={-1} style={style}>
          <button type="button">Primeira opção</button>
          <button type="button">Última opção</button>
        </section>,
        document.body,
      )}
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-trigger")) return new DOMRect(700, 600, 32, 32);
    if (this.hasAttribute("data-panel")) return new DOMRect(0, 0, 260, 220);
    return new DOMRect();
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

describe("popover ancorado", () => {
  it("abre acima do botão, alinhado à direita e abaixo da área da titlebar", () => {
    act(() => root.render(<Example />));
    click(host.querySelector("[data-trigger]")!);
    const panel = document.querySelector<HTMLElement>("[data-panel]")!;
    expect(Number(panel.style.top.replace("px", ""))).toBeGreaterThanOrEqual(48);
    expect(Number(panel.style.top.replace("px", ""))).toBeLessThan(600);
    expect(Number(panel.style.left.replace("px", ""))).toBe(472);
    expect(panel.style.maxHeight).toBe("544px");
  });

  it("vira para baixo quando não há espaço acima e mantém margem da titlebar", () => {
    const position = positionAnchoredPopover(new DOMRect(300, 55, 30, 32), { width: 240, height: 300 }, { width: 800, height: 600 });
    expect(position.top).toBeGreaterThanOrEqual(48);
    expect(position.top).toBe(95);
    expect(position.maxHeight).toBe(493);
  });

  it("prende o foco, fecha com Escape e devolve o foco ao botão", () => {
    act(() => root.render(<Example />));
    const trigger = host.querySelector<HTMLButtonElement>("[data-trigger]")!;
    click(trigger);
    const options = document.querySelectorAll<HTMLButtonElement>("[data-panel] button");
    expect(document.activeElement).toBe(options[0]);
    act(() => {
      options[1]!.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(options[0]);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector("[data-panel]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("fecha ao clicar fora", () => {
    act(() => root.render(<Example />));
    click(host.querySelector("[data-trigger]")!);
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    expect(document.querySelector("[data-panel]")).toBeNull();
  });
});
