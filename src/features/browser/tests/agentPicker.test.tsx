/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { AgentPicker } from "../AgentPicker";

let host: HTMLDivElement;
let root: Root;
/** Onde o botão está agora, na tela. O teste move isto para simular rolagem, redimensionamento ou o composer crescendo. */
let anchor: DOMRect;

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  anchor = rect(100, 300, 200, 30);
  // Só o botão (a raiz do seletor) tem posição; o resto mede zero.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this === host.firstElementChild ? anchor : rect(0, 0, 0, 0);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  act(() => root.unmount());
  host.remove();
});

const picker = () => <AgentPicker agents={[]} value="" onChange={() => {}} />;
const listbox = () => host.querySelector<HTMLElement>("[role=listbox]");
const open = () => act(() => host.querySelector<HTMLButtonElement>("button")!.click());

describe("seletor de agente (A191)", () => {
  it("não mede o botão durante o render (força layout a cada render, mesmo fechado)", () => {
    act(() => root.render(picker()));
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    act(() => root.render(picker()));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("seletor de agente com a lista aberta: a posição acompanha o botão (rodada 2)", () => {
  it("rolar um ancestral do botão faz a lista seguir o botão", () => {
    act(() => root.render(picker()));
    open();
    expect(listbox()?.style.left).toBe("100px");
    // O botão andou (a página rolou): a lista não pode ficar no lugar antigo.
    anchor = rect(180, 300, 200, 30);
    act(() => host.dispatchEvent(new Event("scroll")));
    expect(listbox()?.style.left).toBe("180px");
  });

  it("rolar a própria página (o documento) também faz a lista seguir o botão", () => {
    act(() => root.render(picker()));
    open();
    anchor = rect(120, 260, 200, 30);
    act(() => document.dispatchEvent(new Event("scroll")));
    expect(listbox()?.style.left).toBe("120px");
  });

  it("rolar a própria lista não move nem fecha a lista", () => {
    act(() => root.render(picker()));
    open();
    anchor = rect(180, 300, 200, 30);
    act(() => listbox()!.dispatchEvent(new Event("scroll")));
    expect(listbox()).not.toBeNull();
    expect(listbox()?.style.left).toBe("100px");
  });

  it("rolagem de uma parte que não é ancestral do botão (o chat que escreve) não mexe na lista", () => {
    act(() => root.render(picker()));
    open();
    const transcript = document.createElement("div");
    host.appendChild(transcript);
    anchor = rect(180, 300, 200, 30);
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(listbox()?.style.left).toBe("100px");
  });

  it("o botão que sai da tela fecha a lista", () => {
    act(() => root.render(picker()));
    open();
    anchor = rect(100, -80, 200, 30);
    act(() => host.dispatchEvent(new Event("scroll")));
    expect(listbox()).toBeNull();
  });

  it("redimensionar a janela remede a posição", () => {
    act(() => root.render(picker()));
    open();
    anchor = rect(150, 320, 200, 30);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(listbox()?.style.left).toBe("150px");
  });

  it("o composer crescendo (um ancestral muda de tamanho) remede a posição", () => {
    // Sem rolagem: o ResizeObserver de um ancestral é quem avisa que o botão mudou de lugar.
    const observers: (() => void)[] = [];
    class FakeResizeObserver {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    act(() => root.render(picker()));
    open();
    anchor = rect(100, 280, 200, 30);
    act(() => observers.forEach((callback) => callback()));
    expect(listbox()?.style.top).toBe("316px");
  });
});
