/** @vitest-environment happy-dom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PopupSelect } from "../ui/PopupSelect";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Controlled({ onPick }: { onPick: (v: string) => void }) {
  const [v, setV] = useState("b");
  return (
    <PopupSelect aria-label="Provedor" value={v} onChange={(e) => { setV(e.target.value); onPick(e.target.value); }}>
      <option value="a">Alfa</option>
      <option value="b">Beta</option>
      <optgroup label="Outros"><option value="c">Gama</option><option value="d" disabled>Delta</option></optgroup>
    </PopupSelect>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const button = () => host.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!;
const listbox = () => document.querySelector<HTMLElement>("[role=listbox]");
const menuOptions = () => [...document.querySelectorAll<HTMLElement>("div[role=option]")];
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

describe("PopupSelect", () => {
  it("mostra o selecionado e abre um menu próprio (não o nativo)", () => {
    act(() => root.render(<Controlled onPick={() => {}} />));
    expect(button().getAttribute("aria-label")).toBe("Provedor");
    expect(button().textContent).toContain("Beta");
    click(button());
    expect(listbox()).toBeTruthy();
    expect(menuOptions().map((o) => o.textContent?.replace("✓", ""))).toEqual(["Alfa", "Beta", "Gama", "Delta"]);
    expect(document.body.textContent).toContain("Outros");
  });

  it("escolher chama onChange com event.target.value, como o <select>", () => {
    const onPick = vi.fn();
    act(() => root.render(<Controlled onPick={onPick} />));
    click(button());
    click(menuOptions().find((o) => o.textContent?.includes("Gama"))!);
    expect(onPick).toHaveBeenCalledWith("c");
    expect(listbox()).toBeNull();
    expect(button().textContent).toContain("Gama");
  });

  it("opção desabilitada não é escolhida", () => {
    const onPick = vi.fn();
    act(() => root.render(<Controlled onPick={onPick} />));
    click(button());
    click(menuOptions().find((o) => o.textContent?.includes("Delta"))!);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("teclado: seta para baixo e Enter", () => {
    const onPick = vi.fn();
    act(() => root.render(<Controlled onPick={onPick} />));
    key(button(), "ArrowDown"); // abre no selecionado (Beta)
    key(button(), "ArrowDown"); // Gama
    key(button(), "Enter");
    expect(onPick).toHaveBeenCalledWith("c");
  });

  it("o <select> escondido continua funcionando (testes antigos e formulários)", () => {
    const onPick = vi.fn();
    act(() => root.render(<Controlled onPick={onPick} />));
    const native = host.querySelector("select")!;
    expect(native.getAttribute("aria-label")).toBe("Provedor");
    act(() => { native.value = "a"; native.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onPick).toHaveBeenCalledWith("a");
  });
});
