// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { loadRuntime } from "./runtimeHarness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const response = (body: string) => new Response(body, { status: 200 });

/** Uma página de busca: o botão dispara um fetch lento e, quando chega, pinta os resultados. */
const SEARCH = `<main><input aria-label="Busca"><button id="go">Buscar</button><div id="out" role="status">Nenhuma busca</div></main>`;

function wireSearch(): void {
  document.getElementById("go")!.addEventListener("click", () => {
    window.fetch("/api/search?q=caneca").then((r) => r.text()).then((text) => {
      document.getElementById("out")!.textContent = text;
    });
  });
}

describe("espera por estado no runtime (E1)", () => {
  it("um clique que dispara uma busca lenta só volta quando os resultados estão na tela, e conta o que esperou", async () => {
    const h = await loadRuntime(SEARCH, { fetch: () => sleep(700).then(() => response("3 resultados para caneca")) });
    wireSearch();
    await h.run({ op: "snapshot" });
    const started = Date.now();
    const result = await h.run({ op: "click", target: "e2", fast: true }) as { waited?: string };
    // Antes (350 ms no máximo) o comando voltava com a página antiga.
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
    expect(document.getElementById("out")!.textContent).toBe("3 resultados para caneca");
    expect(result.waited).toMatch(/^esperou 0,\d s \(1 pedido de rede\) — assentou$/);
  });

  it("o mesmo com um XHR do próprio servidor (antes só os de outro origem contavam)", async () => {
    const h = await loadRuntime(SEARCH);
    document.getElementById("go")!.addEventListener("click", () => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/search");
      xhr.send();
      // O XHR de teste não tem rede: termina quando o teste manda.
      setTimeout(() => { document.getElementById("out")!.textContent = "resultado do xhr"; xhr.dispatchEvent(new Event("loadend")); }, 500);
    });
    await h.run({ op: "snapshot" });
    const result = await h.run({ op: "click", target: "e2", fast: true }) as { waited?: string };
    expect(document.getElementById("out")!.textContent).toBe("resultado do xhr");
    expect(result.waited).toMatch(/1 pedido de rede/);
  });

  it("uma página sem nada pendente volta logo e não escreve relatório", async () => {
    const h = await loadRuntime(`<button id="b">Ok</button>`);
    await h.run({ op: "snapshot" });
    const started = Date.now();
    const result = await h.run({ op: "click", target: "e1", fast: true }) as { waited?: string };
    expect(Date.now() - started).toBeLessThan(400);
    expect(result.waited).toBeUndefined();
  });

  it("um pedido que já estava em voo antes do comando (telemetria eterna) não faz o clique esperar", async () => {
    const h = await loadRuntime(`<button id="b">Ok</button>`, { fetch: () => new Promise<Response>(() => undefined) });
    void window.fetch("/api/telemetria"); // eterno, de antes
    await h.run({ op: "snapshot" });
    const started = Date.now();
    const result = await h.run({ op: "click", target: "e1", fast: true }) as { waited?: string };
    expect(Date.now() - started).toBeLessThan(600);
    expect(result.waited).toBeUndefined();
  });

  it("a operação settle conta TODOS os pedidos em voo e pára no teto pedido, dizendo que ainda havia pendência", async () => {
    const h = await loadRuntime(`<div>x</div>`, { fetch: () => new Promise<Response>(() => undefined) });
    void window.fetch("/api/carregando");
    const started = Date.now();
    const result = await h.run({ op: "settle", ceilingMs: 400, fast: true }) as { settled: string; waited?: string; pendingRequests: number };
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(result.settled).toBe("limit");
    expect(result.pendingRequests).toBe(1);
    expect(result.waited).toMatch(/parou no teto de 0 s com a página ainda carregando|parou no teto de \d+ s com a página ainda carregando/);
  });

  it("navegação pendente (beforeunload) segura a espera até o teto", async () => {
    const h = await loadRuntime(`<div>x</div>`);
    window.dispatchEvent(new Event("beforeunload"));
    const pending = await h.run({ op: "settle", ceilingMs: 300, fast: true }) as { settled: string; navigating: boolean; waited?: string };
    expect(pending.settled).toBe("limit");
    expect(pending.navigating).toBe(true);
    expect(pending.waited).toMatch(/navegação pendente/);
  });

  it("settle sem nada pendente responde rápido com o estado do documento", async () => {
    const h = await loadRuntime(`<div>x</div>`);
    const result = await h.run({ op: "settle", fast: true }) as { settled: string; readyState: string; pendingRequests: number; navigating: boolean };
    expect(result).toMatchObject({ settled: "quiet", pendingRequests: 0, navigating: false });
  });
});
