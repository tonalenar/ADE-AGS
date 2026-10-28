// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { loadRuntime } from "./runtimeHarness";

const PAGE = `<main>
  <input id="city" aria-label="Cidade" aria-autocomplete="list" aria-controls="list" autocomplete="off">
  <ul id="list" role="listbox" style="display:none"></ul>
</main>`;

function showOptions(names: string[]): void {
  const list = document.getElementById("list")!;
  list.innerHTML = names.map((n) => `<li role="option">${n}</li>`).join("");
  list.style.display = "block";
}

describe("combobox: depois de digitar, esperar as opções visíveis (E2)", () => {
  it("as sugestões que chegam 120 ms depois de digitar já estão na tela quando o comando volta", async () => {
    const h = await loadRuntime(PAGE);
    document.getElementById("city")!.addEventListener("input", () => setTimeout(() => showOptions(["São Paulo", "Santos", "Santo André"]), 120));
    await h.run({ op: "snapshot" });
    const result = await h.run({ op: "type", target: "e1", text: "san", clear: true, fast: true }) as { options?: number };
    expect(result.options).toBe(3);
    expect(document.querySelectorAll("#list [role=option]").length).toBe(3);
    // E o snapshot seguinte já lista as opções para o Jev escolher.
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/option "Santos" \[ref=e\d+\]/);
  });

  it("sugestões que vêm de um fetch lento (fixture autocomplete-cidade): a espera por estado as aguarda", async () => {
    const h = await loadRuntime(PAGE, { fetch: () => new Promise((r) => setTimeout(() => r(new Response("ok")), 500)) });
    document.getElementById("city")!.addEventListener("input", () => {
      void window.fetch("/api/sugestoes").then(() => showOptions(["Curitiba", "Cuiabá"]));
    });
    await h.run({ op: "snapshot" });
    const result = await h.run({ op: "type", target: "e1", text: "cu", clear: true, fast: true }) as { options?: number };
    expect(result.options).toBe(2);
  });

  it("sugestões que demoram mais que 200 ms por timer simples: não se espera por elas (o Jev lê o que houver)", async () => {
    const h = await loadRuntime(PAGE);
    document.getElementById("city")!.addEventListener("input", () => setTimeout(() => showOptions(["Tarde"]), 700));
    await h.run({ op: "snapshot" });
    const started = Date.now();
    const result = await h.run({ op: "type", target: "e1", text: "x", clear: true, fast: true }) as { options?: number };
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.options).toBe(0);
  });

  it("um campo comum não é combobox: sem espera extra e sem o campo options", async () => {
    const h = await loadRuntime(`<input aria-label="Nome">`);
    await h.run({ op: "snapshot" });
    const started = Date.now();
    const result = await h.run({ op: "type", target: "e1", text: "Ana", clear: true, fast: true }) as { options?: number };
    expect(Date.now() - started).toBeLessThan(300);
    expect(result.options).toBeUndefined();
  });

  it("reconhece role=combobox e aria-haspopup=listbox, e uma lista sem aria-controls", async () => {
    const h = await loadRuntime(`<input role="combobox" aria-label="Busca"><div role="listbox" style="display:none"><div role="option">A</div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => setTimeout(() => { (document.querySelector("[role=listbox]") as HTMLElement).style.display = "block"; }, 60));
    await h.run({ op: "snapshot" });
    const result = await h.run({ op: "type", target: "e1", text: "a", clear: true, fast: true }) as { options?: number };
    expect(result.options).toBe(1);
  });
});
