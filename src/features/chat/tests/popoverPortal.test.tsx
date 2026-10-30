// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PopupSelect } from "@/shared/ui/PopupSelect";
import { usePopover } from "@/features/chat/usePopover";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Um popover com um seletor dentro, como a linha "Conta" do seletor de modelo. */
function Picker({ onPick }: { onPick: (value: string) => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref}>
      <button type="button" onClick={() => setOpen(!open)}>abrir</button>
      {open && (
        <div role="dialog">
          <PopupSelect value="" aria-label="conta" onChange={(e) => onPick(e.target.value)}>
            <option value="">principal</option>
            <option value="acc-2">outra</option>
          </PopupSelect>
        </div>
      )}
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

/** Um clique de verdade: cada evento é entregue e aplicado antes do próximo, como no navegador. */
function click(el: Element) {
  for (const type of ["mousedown", "mouseup", "click"]) {
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); });
  }
}

describe("seletor dentro de um popover (a conta do seletor de modelo)", () => {
  it("escolher uma opção do menu do seletor registra a escolha e não fecha o popover", () => {
    const onPick = vi.fn();
    act(() => root.render(<Picker onPick={onPick} />));
    click(host.querySelector("button")!);
    click(host.querySelector<HTMLElement>("[aria-haspopup='listbox']")!);
    const option = Array.from(document.querySelectorAll<HTMLElement>("[role='option']")).find((el) => el.textContent?.includes("outra"));
    expect(option).not.toBeNull();
    click(option!);
    expect(onPick).toHaveBeenCalledWith("acc-2");
    expect(host.querySelector("[role='dialog']")).not.toBeNull();
  });
});
