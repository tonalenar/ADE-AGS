// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { diffFingerprint, scopeSignature, staleMessage, type Fingerprint } from "../page/guard";
import { loadRuntime, type Harness } from "./runtimeHarness";

const base: Fingerprint = { role: "button", name: "Adicionar Teclado", value: "", checked: false, disabled: false, href: "", scope: "Teclado Adicionar" };

describe("guard: comparar impressões (O1)", () => {
  it("a mesma impressão é o mesmo elemento", () => {
    expect(diffFingerprint(base, { ...base })).toBeNull();
  });

  it("diz o que mudou, na ordem do que mais identifica", () => {
    expect(diffFingerprint(base, { ...base, name: "Adicionar Fone" })).toBe('o nome: "Adicionar Teclado" → "Adicionar Fone"');
    expect(diffFingerprint(base, { ...base, href: "/p/2" })).toMatch(/^o destino/);
    expect(diffFingerprint(base, { ...base, checked: true })).toBe("o estado marcado: false → true");
    expect(diffFingerprint(base, { ...base, disabled: true })).toMatch(/desabilitado/);
    expect(diffFingerprint(base, { ...base, value: "x" })).toMatch(/^o valor/);
    expect(diffFingerprint(base, { ...base, role: "link" })).toMatch(/^o tipo/);
  });

  it("a recusa usa as palavras que o piloto reconhece para reler a página", () => {
    expect(staleMessage("e3", "o nome")).toMatch(/tire um novo snapshot/);
    expect(staleMessage("e3", "o nome")).toMatch(/^stale: e3/);
  });
});

describe("scopeSignature: o texto em volta, sem números", () => {
  it("troca números por # (um contador não faz outro elemento) e colapsa espaços", () => {
    expect(scopeSignature("Qty   2 \n R$ 19,90")).toBe("Qty # R$ #");
    expect(scopeSignature("Qty 3 R$ 29,90")).toBe(scopeSignature("Qty 2 R$ 19,90"));
  });

  it("um produto que vira outro muda a assinatura", () => {
    expect(scopeSignature("Teclado Mecânico")).not.toBe(scopeSignature("Fone Bluetooth"));
  });

  it("escopo vazio ou grande demais (um form que envolve a página) não identifica nada", () => {
    expect(scopeSignature("   ")).toBe("");
    expect(scopeSignature(undefined)).toBe("");
    expect(scopeSignature("palavra ".repeat(200))).toBe("");
  });
});

/** Dois cartões cujos nós são reaproveitados: o título e o botão trocam de produto sem sair do lugar (React com chave por índice). */
const CARDS = `
  <main>
    <div class="card"><h2>Teclado Mecânico</h2><button id="b1" aria-label="Adicionar Teclado Mecânico ao carrinho">Adicionar</button></div>
    <div class="card"><h2>Fone Bluetooth</h2><button id="b2" aria-label="Adicionar Fone Bluetooth ao carrinho">Adicionar</button></div>
  </main>`;

function reorder(): void {
  const cards = document.querySelectorAll(".card");
  const names = ["Fone Bluetooth", "Teclado Mecânico"];
  cards.forEach((card, i) => {
    card.querySelector("h2")!.textContent = names[i];
    card.querySelector("button")!.setAttribute("aria-label", `Adicionar ${names[i]} ao carrinho`);
  });
}

describe("guarda no runtime: nó reaproveitado não produz clique no elemento errado (O1)", () => {
  let h: Harness;
  let clicks: string[];

  beforeEach(async () => {
    h = await loadRuntime(CARDS);
    clicks = [];
    for (const id of ["b1", "b2"]) {
      document.getElementById(id)!.addEventListener("click", () => clicks.push(`${id}:${document.getElementById(id)!.getAttribute("aria-label")}`));
    }
  });

  it("sem mudança, o toque acontece", async () => {
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toContain("[ref=e1]");
    await h.run({ op: "click", target: "e1", fast: true });
    expect(clicks).toEqual(["b1:Adicionar Teclado Mecânico ao carrinho"]);
  });

  it("depois do re-render que troca o produto do nó, o ref antigo devolve stale e NÃO clica", async () => {
    await h.run({ op: "snapshot" });
    reorder();
    await expect(h.run({ op: "click", target: "e1", fast: true })).rejects.toThrow(/^stale: e1 mudou.*Teclado Mecânico.*tire um novo snapshot/s);
    expect(clicks).toEqual([]);
  });

  it("relido o snapshot, o ref novo aponta para o produto certo e age", async () => {
    await h.run({ op: "snapshot" });
    reorder();
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/button "Adicionar Fone Bluetooth ao carrinho" \[ref=e1\]/);
    await h.run({ op: "click", target: "e1", fast: true });
    expect(clicks).toEqual(["b1:Adicionar Fone Bluetooth ao carrinho"]);
  });

  it("vale também para digitar e escolher: não age quando o campo virou outro", async () => {
    await h.run({ op: "snapshot" });
    const input = document.createElement("input");
    document.querySelector("main")!.append(input);
    const snap = String(await h.run({ op: "snapshot" }));
    const ref = /textbox.*\[ref=(e\d+)\]/.exec(snap)![1];
    input.setAttribute("placeholder", "Outro campo");
    await expect(h.run({ op: "type", target: ref, text: "oi", clear: true, fast: true })).rejects.toThrow(/stale/);
    expect(input.value).toBe("");
  });

  it("uma mudança de destino do link também é stale", async () => {
    document.querySelector("main")!.insertAdjacentHTML("beforeend", `<a id="l" href="/p/1">Ver</a>`);
    await h.run({ op: "snapshot" });
    const link = document.getElementById("l")!;
    let followed = 0;
    link.addEventListener("click", (e) => { e.preventDefault(); followed += 1; });
    const ref = /link "Ver" \[ref=(e\d+)\]/.exec(String(await h.run({ op: "snapshot" })))![1];
    link.setAttribute("href", "/p/2");
    await expect(h.run({ op: "click", target: ref, fast: true })).rejects.toThrow(/o destino/);
    expect(followed).toBe(0);
  });
});

describe("guarda no runtime: o que o próprio agente muda não é «stale»", () => {
  it("repetir o toque no mesmo ref depois de ele mudar o contador em volta funciona (+ duas vezes)", async () => {
    const h = await loadRuntime(`<ul><li id="row"><span id="qty">Qty 1</span> <button id="plus" aria-label="Mais">+</button></li></ul>`);
    document.getElementById("plus")!.addEventListener("click", () => {
      const n = Number(/\d+/.exec(document.getElementById("qty")!.textContent!)![0]) + 1;
      document.getElementById("qty")!.textContent = `Qty ${n}`;
    });
    await h.run({ op: "snapshot" });
    await h.run({ op: "click", target: "e1", fast: true });
    await h.run({ op: "click", target: "e1", fast: true });
    expect(document.getElementById("qty")!.textContent).toBe("Qty 3");
  });

  it("digitar duas vezes no mesmo campo, sem novo snapshot, funciona", async () => {
    const h = await loadRuntime(`<form><input aria-label="Busca"></form>`);
    await h.run({ op: "snapshot" });
    await h.run({ op: "type", target: "e1", text: "abc", clear: true, fast: true });
    await h.run({ op: "type", target: "e1", text: "xyz", clear: true, fast: true });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("xyz");
  });

  it("um alvo por texto ou seletor não passa pela guarda (resolve na hora)", async () => {
    const h = await loadRuntime(`<button id="ok">Confirmar</button>`);
    let n = 0;
    document.getElementById("ok")!.addEventListener("click", () => { n += 1; });
    await h.run({ op: "click", target: "text=Confirmar", fast: true });
    await h.run({ op: "click", target: "#ok", fast: true });
    expect(n).toBe(2);
  });
});
