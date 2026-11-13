/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const i18nResult = { t: (k: string) => k };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

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

describe("barra do modo celular", () => {
  it("troca o aparelho emulado entre iPhone, Android e mesa", () => {
    const onMobile = vi.fn();
    act(() => root.render(
      <DeviceBar viewport={{ width: 390, height: 844 }} mobile="ios" onChange={() => {}} onMobile={onMobile} onFull={() => {}} onClose={() => {}} />,
    ));
    const radios = [...host.querySelectorAll<HTMLButtonElement>("[aria-label='browser.viewport.platform'] [role=radio]")];
    expect(radios.map((r) => r.textContent)).toEqual(["browser.viewport.ios", "browser.viewport.android", "browser.viewport.desktop"]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    act(() => radios[1]!.click());
    expect(onMobile).toHaveBeenCalledWith("android");
    act(() => radios[2]!.click());
    expect(onMobile).toHaveBeenCalledWith(null);
  });

  it("não tem mais a faixa de breakpoints nem o botão de toque soltos", () => {
    act(() => root.render(
      <DeviceBar viewport={{ width: 390, height: 844 }} mobile={null} onChange={() => {}} onMobile={() => {}} onFull={() => {}} onClose={() => {}} />,
    ));
    expect(host.querySelector("[aria-label='browser.viewport.breakpoints'][role=group]")).toBeNull();
    expect(host.textContent).not.toContain("browser.viewport.touch");
  });

  it("alterna entre o aparelho e o completo; sem quadro não mostra o tamanho", () => {
    const onFull = vi.fn();
    act(() => root.render(
      <DeviceBar viewport={null} mobile="ios" onChange={() => {}} onMobile={() => {}} onFull={onFull} onClose={() => {}} />,
    ));
    const layout = [...host.querySelectorAll<HTMLButtonElement>("[aria-label='browser.viewport.layout'] [role=radio]")];
    expect(layout.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(host.querySelector("input")).toBeNull();
    act(() => layout[0]!.click());
    expect(onFull).toHaveBeenCalledWith(false);
  });
});
