// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComposerColumn } from "../ComposerColumn";
import { ChatComposer } from "../ChatComposer";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

/** Um ResizeObserver de mentira que só avisa uma vez, ao observar. */
class FakeObserver {
  static widths: number[] = [];
  constructor(private cb: () => void) {}
  observe() { this.cb(); }
  disconnect() { /* nada */ }
}

let root: Root;
let host: HTMLDivElement;
const renderAt = async (width: number) => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => width });
  await act(async () => { root.render(<ComposerColumn key={width}><span data-testid="filho">x</span></ComposerColumn>); });
  return host.firstElementChild as HTMLElement;
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FakeObserver });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.unstubAllGlobals(); });

describe("a coluna do composer", () => {
  it("a margem acompanha a largura da coluna, não a da janela", async () => {
    expect((await renderAt(360)).style.paddingInline).toBe("12px");
    expect((await renderAt(440)).style.paddingInline).toBe("16px");
    expect((await renderAt(720)).style.paddingInline).toBe("48px");
  });
});

describe("a linha de controles do composer", () => {
  const mount = (controls: React.ReactNode, leading?: React.ReactNode) => act(async () => {
    root.render(<ChatComposer placeholder="p" onSubmit={() => undefined} controls={controls} leading={leading} />);
  });

  it("quebra em duas linhas em vez de estourar, com o enviar por último no grupo da direita", async () => {
    await mount(<button type="button">modelo</button>, <button type="button">Time</button>);
    const row = host.querySelector("[data-composer-row]") as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    const right = host.querySelector("[data-composer-right]") as HTMLElement;
    expect(right.className).toContain("ml-auto");
    const last = right.lastElementChild as HTMLButtonElement;
    expect(last.type).toBe("submit");
    expect(last.getAttribute("aria-label")).toBe("chat.composer.send");
    // O grupo dos controles também quebra: nada passa da borda do cartão.
    expect((host.querySelector("[data-composer-controls]") as HTMLElement).className).toContain("flex-wrap");
  });

  it("anexar e o segmentado ficam à esquerda; os controles à direita", async () => {
    await mount(<button type="button">modelo</button>, <button type="button">Time</button>);
    const left = host.querySelector("[data-composer-left]") as HTMLElement;
    expect(left.textContent).toContain("Time");
    expect(left.querySelector("button[aria-label='chat.composer.attach']")).not.toBeNull();
    expect((host.querySelector("[data-composer-right]") as HTMLElement).textContent).toContain("modelo");
  });

  it("o alvo do anexar e do enviar tem pelo menos 28 px (w-7/h-7 e w-8/h-8)", async () => {
    await mount(null);
    expect(host.querySelector("button[aria-label='chat.composer.attach']")!.className).toMatch(/w-7 h-7/);
    expect(host.querySelector("button[type=submit]")!.className).toMatch(/w-8 h-8/);
  });
});
