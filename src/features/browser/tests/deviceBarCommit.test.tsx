/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { DeviceBar } from "../DeviceBar";

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
});

/** Digita como a pessoa faz: o valor do campo muda e dispara `input`, que o React lê. */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("campo de largura do aparelho (A189)", () => {
  it("digitar abaixo do mínimo e confirmar repõe o valor que ficou: o clamp pode devolver o mesmo número", () => {
    const onChange = vi.fn();
    // A prop fica em 240, o mínimo. O pai recebe o clamp mas não muda a prop, então o effect não rodaria.
    act(() => root.render(
      <DeviceBar viewport={{ width: 240, height: 500 }} mobile={null} onChange={onChange} onMobile={() => {}} onFull={() => {}} onClose={() => {}} />,
    ));
    const input = host.querySelector<HTMLInputElement>("input[aria-label='browser.viewport.width']")!;
    act(() => typeInto(input, "100"));
    // Antes do Enter, o campo tem de ter recebido o que foi digitado: senão o teste não prova nada.
    expect(input.value).toBe("100");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onChange).toHaveBeenCalledWith({ width: 240, height: 500 });
    expect(input.value).toBe("240");
  });
});
