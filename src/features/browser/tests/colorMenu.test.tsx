/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { ColorMenu } from "../annotate/Annotator";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  host.remove();
});

// Uma cor que não está na lista cai na primeira: o teste não depende dos valores de cor.
const session = { color: "sem-correspondencia" } as never;

describe("paleta de cores da anotação (A191)", () => {
  it("não mede o botão a cada render enquanto a paleta está aberta", () => {
    act(() => root.render(<ColorMenu session={session} />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    // Com a paleta aberta, um render de novo não pode voltar a forçar layout para medir o âncora.
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    act(() => root.render(<ColorMenu session={session} />));
    expect(spy).not.toHaveBeenCalled();
  });

  it("rolar a barra com a paleta aberta a fecha", () => {
    act(() => root.render(<ColorMenu session={session} />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector("[role=group]")).not.toBeNull();
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(host.querySelector("[role=group]")).toBeNull();
  });
});
