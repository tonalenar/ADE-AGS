// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRuntime } from "./runtimeHarness";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("runtime: o que a ação logou chega antes da resposta", () => {
  it("o debug:batch sai ANTES do page:reply, então a app não precisa esperar a tanda", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(`<button id="b">Quebrar</button>`);
    document.getElementById("b")!.addEventListener("click", () => console.error("falhou a API"));
    await vi.advanceTimersByTimeAsync(1_000).then(() => h.run({ op: "snapshot" }));
    h.sent.length = 0;
    const pending = h.run({ op: "click", target: "e1", fast: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    const kinds = h.sent.map((m) => m.type);
    expect(kinds.indexOf("debug:batch")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("debug:batch")).toBeLessThan(kinds.indexOf("page:reply"));
  });
});

describe("runtime: layout depois do resize por evento", () => {
  it("espera o evento resize e conclui logo depois dele, sem chegar ao teto de 400 ms", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(`<main>x</main>`);
    let done = false;
    const t0 = Date.now();
    const pending = h.run({ op: "layout", afterResize: { since: t0, capMs: 400 } }).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(120);
    expect(done).toBe(false);
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(done).toBe(true);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("um resize que já aconteceu depois do pedido não é esperado de novo", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(`<main>x</main>`);
    const since = Date.now();
    await vi.advanceTimersByTimeAsync(10);
    window.dispatchEvent(new Event("resize"));
    const started = Date.now();
    const pending = h.run({ op: "layout", afterResize: { since, capMs: 400 } });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("sem evento nenhum, o teto de 400 ms manda", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(`<main>x</main>`);
    let done = false;
    const pending = h.run({ op: "layout", afterResize: { since: Date.now(), capMs: 400 } }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(399);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(done).toBe(true);
  });
});
