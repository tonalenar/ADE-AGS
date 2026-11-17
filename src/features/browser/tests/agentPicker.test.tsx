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

const picker = () => <AgentPicker agents={[]} value="" onChange={() => {}} />;

describe("seletor de agente (A191)", () => {
  it("não mede o botão durante o render (força layout a cada render, mesmo fechado)", () => {
    act(() => root.render(picker()));
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    act(() => root.render(picker()));
    expect(spy).not.toHaveBeenCalled();
  });

  it("rolar com a lista aberta fecha a lista, em vez de deixá-la solta do botão", () => {
    act(() => root.render(picker()));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector("[role=listbox]")).not.toBeNull();
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(host.querySelector("[role=listbox]")).toBeNull();
  });
});
