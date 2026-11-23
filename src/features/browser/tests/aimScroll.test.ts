// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntime } from "./runtimeHarness";

const rectOf = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aim: rolagem apenas quando o elemento está fora da viewport", () => {
  it("nao_chama_scrollIntoView_quando_elemento_ja_esta_visivel_na_viewport", async () => {
    const rt = await loadRuntime(`<button id="ok">Confirmar</button>`);
    const button = document.getElementById("ok") as HTMLButtonElement;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    button.getBoundingClientRect = () => rectOf(100, 120, 120, 36);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(button);
    const scrollSpy = vi.fn();
    button.scrollIntoView = scrollSpy;

    await rt.run({ op: "click", target: "#ok", fast: true });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("usa_scrollIntoView_nearest_quando_elemento_esta_fora_da_viewport", async () => {
    const rt = await loadRuntime(`<button id="far">Carregar</button>`);
    const button = document.getElementById("far") as HTMLButtonElement;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    let inView = false;
    button.getBoundingClientRect = () => (inView ? rectOf(100, 700, 120, 36) : rectOf(100, 1600, 120, 36));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(button);
    const scrollSpy = vi.fn(() => { inView = true; });
    button.scrollIntoView = scrollSpy;

    await rt.run({ op: "click", target: "#far", fast: true });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});
