/** @vitest-environment happy-dom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PopupSelect } from "../ui/PopupSelect";
import { hasOpenDialog } from "../ui/openDialog";

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
  it("Escape fecha só o menu: é cancelado (não vira cancel do dialog) e o menu aberto conta como dono do Escape", () => {
    act(() => root.render(<Controlled onPick={() => {}} />));
    click(button());
    expect(hasOpenDialog()).toBe(true);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { button().dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(listbox()).toBeNull();
    expect(hasOpenDialog()).toBe(false);
  });

  it("não deixa listener de resize para trás a cada abertura", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    act(() => root.render(<Controlled onPick={() => {}} />));
    for (let i = 0; i < 3; i++) { click(button()); click(button()); }
    const added = add.mock.calls.filter((c) => c[0] === "resize").length;
    const removed = remove.mock.calls.filter((c) => c[0] === "resize").length;
    expect(added).toBe(removed);
    add.mockRestore(); remove.mockRestore();
  });

  it("dentro de um <dialog> modal o menu abre dentro dele (fora dele tudo fica inerte)", () => {
    const dialog = document.createElement("dialog");
    document.body.appendChild(dialog);
    const inner = createRoot(dialog);
    act(() => inner.render(<Controlled onPick={() => {}} />));
    click(dialog.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!);
    expect(dialog.querySelector("[role=listbox]")).toBeTruthy();
    act(() => inner.unmount());
    dialog.remove();
  });

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

  it("junta as opções que vêm de uma fileira fixa, de um .map() filtrado e de outro .map() (como o seletor de conta)", () => {
    const accounts = [{ id: null, name: "Sistema" }, { id: "t", name: "Ton" }, { id: "m", name: "Maria" }];
    act(() => root.render(
      <PopupSelect aria-label="Conta" value="">
        <option value="">Conta principal</option>
        {accounts.filter((a) => a.id !== null).map((a) => <option key={a.id!} value={a.id!}>{a.name}</option>)}
        {[{ id: "p", name: "pool" }].map((p) => <option key={p.id} value={`pool:${p.name}`}>Pool {p.name}</option>)}
      </PopupSelect>,
    ));
    click(button());
    expect(menuOptions().map((o) => o.textContent)).toEqual(["✓Conta principal", "Ton", "Maria", "Pool pool"]);
  });

  it("a altura estimada do menu cabe todas as linhas (30px cada + o respiro), sem barra de rolagem à toa", () => {
    act(() => root.render(<Controlled onPick={() => {}} />));
    click(button());
    const menu = listbox()!;
    // 4 opções (+ 1 cabeçalho de grupo ficam dentro do teto de 320): 4 × 30 + 12
    expect(parseInt(menu.style.maxHeight, 10)).toBeGreaterThanOrEqual(4 * 30 + 12);
  });
});
