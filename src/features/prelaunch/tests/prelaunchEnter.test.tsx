/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Configura flag global para react act em ambiente happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/prelaunch/store", () => ({
  usePrelaunchStore: (selector: (s: Record<string, unknown>) => unknown) => selector(store.state),
}));
vi.mock("@/features/settings/SettingsSection", async () => {
  const React = await import("react");
  return { SettingsSection: ({ children }: { children: unknown }) => React.createElement("div", null, children as never) };
});

import { PrelaunchSection } from "../PrelaunchSection";

let host: HTMLDivElement;
let root: Root;

/** Escreve num input controlado do React: o setter nativo + evento de `input`. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  store.state = { presets: [], loaded: true, load: () => {}, save: vi.fn(() => new Promise(() => {})), remove: vi.fn() };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe("PrelaunchSection: ⏎ no formulário enquanto salva (A175)", () => {
  it("um segundo ⏎ com o salvamento em andamento não salva de novo", async () => {
    await act(async () => { root.render(<PrelaunchSection />); });
    const [nameInput, commandInput] = Array.from(host.querySelectorAll("input")) as HTMLInputElement[];
    await act(async () => { setValue(nameInput, "api"); });
    await act(async () => { setValue(commandInput, "bun dev"); });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { commandInput.dispatchEvent(enter); });
    await act(async () => { commandInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(store.state.save).toHaveBeenCalledTimes(1);
  });
});
