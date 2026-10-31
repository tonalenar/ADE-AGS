// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve([]) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { ChatComposer } from "../ChatComposer";

let root: Root;
let host: HTMLDivElement;
let content = 22;
let width = 600;
let notify: (() => void) | null = null;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  content = 22; width = 600; notify = null;
  // O happy-dom não faz layout: a altura do conteúdo e a largura da caixa são as que o teste manda.
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(HTMLTextAreaElement.prototype, "offsetWidth", { configurable: true, get: () => width });
  globalThis.ResizeObserver = class { constructor(cb: () => void) { notify = cb; } observe() {} disconnect() {} unobserve() {} } as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const mount = () => act(async () => { root.render(<ChatComposer placeholder="p" onSubmit={() => true} />); });
const area = () => host.querySelector("textarea") as HTMLTextAreaElement;
const type = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area(), value);
  area().dispatchEvent(new Event("input", { bubbles: true }));
});

describe("o campo cresce com o que se digita", () => {
  it("a altura acompanha o conteúdo, linha a linha, a cada digitação", async () => {
    await mount();
    expect(area().style.height).toBe("22px");
    content = 44; await type("a\nb");
    expect(area().style.height).toBe("44px");
    content = 88; await type("a\nb\nc\nd");
    expect(area().style.height).toBe("88px");
    content = 22; await type("");
    expect(area().style.height).toBe("22px");
  });

  it("quando a largura muda (painel abre) o texto quebra de outro jeito e a altura é refeita sem digitar", async () => {
    await mount();
    content = 44; await type("um texto que passa de uma linha");
    expect(area().style.height).toBe("44px");
    width = 300; content = 88;
    await act(async () => { notify!(); });
    expect(area().style.height).toBe("88px");
  });

  it("o miolo rola por dentro com teto de 40% da janela; o campo em si não tem altura máxima própria", async () => {
    await mount();
    const scroller = host.querySelector(".cc-scroll-hidden") as HTMLElement;
    expect(parseInt(scroller.style.maxHeight, 10)).toBe(Math.max(160, Math.floor(window.innerHeight * 0.4)));
    expect(area().style.maxHeight).toBe("");
  });
});
