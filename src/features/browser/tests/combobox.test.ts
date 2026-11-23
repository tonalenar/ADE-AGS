// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

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

/** Roda o comando com o relógio falso: o tempo avança só aqui, então nenhum timer sobrevive ao teste. */
async function runTimed<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("combobox: depois de digitar, esperar as opções visíveis (E2)", () => {
  it("as sugestões que chegam 120 ms depois de digitar já estão na tela quando o comando volta", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(PAGE);
    document.getElementById("city")!.addEventListener("input", () => setTimeout(() => showOptions(["São Paulo", "Santos", "Santo André"]), 120));
    await runTimed(h.run({ op: "snapshot" }));
    const result = await runTimed(h.run({ op: "type", target: "e1", text: "san", clear: true, fast: true })) as { options?: number };
    expect(result.options).toBe(3);
    expect(document.querySelectorAll("#list [role=option]").length).toBe(3);
    // E o snapshot seguinte já lista as opções para o Jev escolher.
    const snap = String(await runTimed(h.run({ op: "snapshot" })));
    expect(snap).toMatch(/option "Santos" \[ref=e\d+\]/);
  });

  it("sugestões que vêm de um fetch lento (fixture autocomplete-cidade): a espera por estado as aguarda", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(PAGE, { fetch: () => new Promise((r) => setTimeout(() => r(new Response("ok")), 500)) });
    document.getElementById("city")!.addEventListener("input", () => {
      void window.fetch("/api/sugestoes").then(() => showOptions(["Curitiba", "Cuiabá"]));
    });
    await runTimed(h.run({ op: "snapshot" }));
    const result = await runTimed(h.run({ op: "type", target: "e1", text: "cu", clear: true, fast: true })) as { options?: number };
    expect(result.options).toBe(2);
  });

  it("sugestões que demoram mais que 200 ms por timer simples: não se espera por elas (o Jev lê o que houver)", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(PAGE);
    document.getElementById("city")!.addEventListener("input", () => setTimeout(() => showOptions(["Tarde"]), 700));
    await runTimed(h.run({ op: "snapshot" }));
    const started = Date.now();
    // O relógio é o falso: o comando tem de voltar antes de 500 ms de tempo virtual, não de relógio de parede.
    let doneAt = 0;
    const pending = h.run({ op: "type", target: "e1", text: "x", clear: true, fast: true }).then((r) => { doneAt = Date.now(); return r; });
    const result = await runTimed(pending) as { options?: number };
    expect(doneAt - started).toBeLessThan(500);
    expect(result.options).toBe(0);
  });

  it("um campo comum não é combobox: sem espera extra e sem o campo options", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(`<input aria-label="Nome">`);
    await runTimed(h.run({ op: "snapshot" }));
    const started = Date.now();
    let doneAt = 0;
    const pending = h.run({ op: "type", target: "e1", text: "Ana", clear: true, fast: true }).then((r) => { doneAt = Date.now(); return r; });
    const result = await runTimed(pending) as { options?: number };
    expect(doneAt - started).toBeLessThan(300);
    expect(result.options).toBeUndefined();
  });

  it("reconhece role=combobox e aria-haspopup=listbox, e uma lista sem aria-controls", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(`<input role="combobox" aria-label="Busca"><div role="listbox" style="display:none"><div role="option">A</div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => setTimeout(() => { (document.querySelector("[role=listbox]") as HTMLElement).style.display = "block"; }, 60));
    await runTimed(h.run({ op: "snapshot" }));
    const result = await runTimed(h.run({ op: "type", target: "e1", text: "a", clear: true, fast: true })) as { options?: number };
    expect(result.options).toBe(1);
  });

  it("aria-controls com a letra «s» no id (search-list) liga o combobox à lista certa, e role com vários tokens vale", async () => {
    vi.useFakeTimers();
    const h = await loadRuntime(`<input role="combobox listbox" aria-label="Busca" aria-controls="search-list">
      <ul id="search-list" role="listbox" style="display:none"></ul>
      <ul role="listbox"><li role="option">De outro menu</li></ul>`);
    document.querySelector("input")!.addEventListener("input", () => setTimeout(() => {
      const list = document.getElementById("search-list")!;
      list.innerHTML = `<li role="option">Certa</li>`;
      list.style.display = "block";
    }, 60));
    await runTimed(h.run({ op: "snapshot" }));
    const result = await runTimed(h.run({ op: "type", target: "e1", text: "a", clear: true, fast: true })) as { options?: number };
    // Com o `/s+/` quebrado, o id virava ["", "earch-li", "t"], a ligação se perdia e contava a opção do OUTRO menu (1) antes da certa.
    expect(result.options).toBe(1);
    const snap = String(await runTimed(h.run({ op: "snapshot" })));
    expect(snap).toMatch(/option "Certa"/);
  });
});
