/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
const i18nResult = { t: (k: string, o?: Record<string, unknown>) => (o ? `${k} ${JSON.stringify(o)}` : k) };
vi.mock("react-i18next", () => ({ useTranslation: () => i18nResult }));

import { UsagePricesSettings } from "../UsagePricesSettings";

const view = (overrides: { model: string; input: number; output: number }[] = []) => ({
  overrides,
  list: [{ family: "Claude Sonnet", input: 3, output: 15 }],
});

let container: HTMLDivElement;
let root: Root;

/** Digita num campo controlado pelo React (dispara o evento que o React escuta). */
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const byLabel = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const buttonWith = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  invokeMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Uso e preços: o formulário de preço por modelo", () => {
  it("manda o modelo e os preços digitados com vírgula, e a lista volta atualizada", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "usage_prices_get") return view();
      if (cmd === "usage_price_set") return view([{ model: "claude-opus-4-5", input: 5.5, output: 25 }]);
      throw new Error(`comando inesperado ${cmd}`);
    });
    await act(async () => root.render(<UsagePricesSettings />));
    await flush();
    await act(async () => {
      type(byLabel("settings.usage.prices.model"), "Claude-Opus-4-5");
      type(byLabel("settings.usage.prices.input"), "5,5");
      type(byLabel("settings.usage.prices.output"), "25");
    });
    await act(async () => buttonWith("settings.usage.prices.save").click());
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("usage_price_set", { model: "Claude-Opus-4-5", input: 5.5, output: 25 });
    expect(container.textContent).toContain("claude-opus-4-5");
  });

  it("mostra a mensagem que o backend devolveu quando o preço é recusado", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "usage_prices_get") return view();
      throw "O preço precisa estar entre 0 e 10 000 USD por milhão de tokens.";
    });
    await act(async () => root.render(<UsagePricesSettings />));
    await flush();
    await act(async () => {
      type(byLabel("settings.usage.prices.model"), "m");
      type(byLabel("settings.usage.prices.input"), "1");
      type(byLabel("settings.usage.prices.output"), "2");
    });
    await act(async () => buttonWith("settings.usage.prices.save").click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("10 000 USD");
  });

  it("não manda nada quando um preço não é número: pede de novo", async () => {
    invokeMock.mockImplementation(async () => view());
    await act(async () => root.render(<UsagePricesSettings />));
    await flush();
    await act(async () => {
      type(byLabel("settings.usage.prices.model"), "m");
      type(byLabel("settings.usage.prices.input"), "abc");
      type(byLabel("settings.usage.prices.output"), "2");
    });
    await act(async () => buttonWith("settings.usage.prices.save").click());
    await flush();
    expect(invokeMock).not.toHaveBeenCalledWith("usage_price_set", expect.anything());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("settings.usage.prices.invalidNumber");
  });
});
