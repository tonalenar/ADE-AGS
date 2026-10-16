// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRuntime } from "./runtimeHarness";

afterEach(() => vi.restoreAllMocks());

/** O clique de um link não pode navegar de verdade no teste: o ouvinte cancela depois da captura do runtime. */
function stopNavigation(el: Element): void {
  el.addEventListener("click", (e) => e.preventDefault());
}

describe("target=_blank e window.open ficam no mesmo portal (E4)", () => {
  it("um link target=_blank clicado por um agente passa a abrir aqui", async () => {
    const h = await loadRuntime(`<a id="l" href="/produto/1" target="_blank">Ver produto</a>`);
    stopNavigation(document.getElementById("l")!);
    await h.run({ op: "snapshot" });
    await h.run({ op: "click", target: "e1", fast: true });
    expect(document.getElementById("l")!.getAttribute("target")).toBe("_self");
  });

  it("_top e _parent (que levariam a app inteira para outro site) e um nome de janela também", async () => {
    const h = await loadRuntime(`<a id="a" href="/a" target="_top">A</a><a id="b" href="/b" target="_parent">B</a><a id="c" href="/c" target="janela">C</a>`);
    for (const id of ["a", "b", "c"]) stopNavigation(document.getElementById(id)!);
    await h.run({ op: "snapshot" });
    for (const ref of ["e1", "e2", "e3"]) await h.run({ op: "click", target: ref, fast: true });
    expect(["a", "b", "c"].map((id) => document.getElementById(id)!.getAttribute("target"))).toEqual(["_self", "_self", "_self"]);
  });

  it("um clique da pessoa (sem agente) não é mexido", async () => {
    await loadRuntime(`<a id="l" href="/produto/1" target="_blank">Ver</a>`);
    const link = document.getElementById("l")!;
    stopNavigation(link);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("um formulário com target=_blank e o formtarget do botão de envio também ficam aqui", async () => {
    const h = await loadRuntime(`<form id="f" action="/busca" target="_blank"><input name="q"><button id="go" formtarget="_blank">Buscar</button></form>`);
    document.getElementById("f")!.addEventListener("submit", (e) => e.preventDefault());
    await h.run({ op: "snapshot" });
    await h.run({ op: "click", target: "e2", fast: true });
    expect(document.getElementById("f")!.getAttribute("target")).toBe("_self");
    expect(document.getElementById("go")!.getAttribute("formtarget")).toBe("_self");
  });

  it("window.open para o mesmo site, durante a ação de um agente, navega aqui e devolve uma janela de mentira", async () => {
    const assign = vi.fn();
    const h = await loadRuntime(`<button id="b">Abrir</button>`);
    Object.defineProperty(window, "location", { value: { href: "http://localhost:3000/", origin: "http://localhost:3000", assign }, configurable: true });
    let popup: unknown;
    document.getElementById("b")!.addEventListener("click", () => { popup = window.open("/oferta", "_blank"); });
    await h.run({ op: "snapshot" });
    await h.run({ op: "click", target: "e1", fast: true });
    expect(assign).toHaveBeenCalledWith("http://localhost:3000/oferta");
    expect((popup as { closed: boolean }).closed).toBe(false);
    expect(() => (popup as { focus: () => void }).focus()).not.toThrow();
  });

  it("window.open para outro site pede à app para abrir neste portal (nav:open), igual a um link", async () => {
    const h = await loadRuntime(`<button id="b">Abrir</button>`);
    document.getElementById("b")!.addEventListener("click", () => { window.open("https://outro.example/pagina?x=1"); });
    await h.run({ op: "snapshot" });
    await h.run({ op: "click", target: "e1", fast: true });
    const opened = h.sent.find((m) => m.type === "nav:open");
    expect(opened).toMatchObject({ type: "nav:open", payload: { url: "https://outro.example/pagina?x=1" } });
  });

  it("window.open fora de uma ação de agente, sem URL, about:blank ou mailto: seguem o comportamento de sempre", async () => {
    const native = vi.fn(() => null);
    window.open = native as unknown as typeof window.open;
    const h = await loadRuntime(`<button id="b">Abrir</button>`);
    // fora de uma ação
    window.open("/x");
    expect(native).toHaveBeenCalledTimes(1);
    document.getElementById("b")!.addEventListener("click", () => {
      window.open();
      window.open("about:blank");
      window.open("mailto:a@b.c");
    });
    await h.run({ op: "snapshot" });
    await h.run({ op: "click", target: "e1", fast: true });
    expect(native).toHaveBeenCalledTimes(4);
  });
});
