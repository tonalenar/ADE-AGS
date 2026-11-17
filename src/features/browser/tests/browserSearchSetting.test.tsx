/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { BrowserSearchSetting } from "../BrowserSearchSetting";
import { readBrowserSearchPreferences } from "../searchPreferences";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("motor de busca (A190)", () => {
  it("escolher Personalizado com um modelo inválido não deixa o seletor mostrando um motor que não foi salvo", () => {
    const before = readBrowserSearchPreferences().engine;
    act(() => root.render(<BrowserSearchSetting />));
    const select = host.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      select.value = "custom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Modelo vazio é inválido: a escolha não entra na tela (o salvo continua o mesmo).
    expect(select.value).toBe(before);
    expect(readBrowserSearchPreferences().engine).toBe(before);
  });
});
