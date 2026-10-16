import { describe, expect, it } from "vitest";

import { pilotDeps } from "../agentBridge";
import type { BrowserHost } from "../agentBridge";
import { cartNote, createLedger, LEDGER_SIZE } from "../portalLedger";
import type { PageCommand } from "../protocol";

describe("portalLedger: o histórico por portal entre acts (D6)", () => {
  const entry = (what: string, cartBefore: number | null = null, cartAfter: number | null = null) =>
    ({ what, changed: true as boolean | null, cartBefore, cartAfter });

  it("o act seguinte recebe as ações do anterior, marcadas e com a contagem do carrinho", () => {
    const ledger = createLedger();
    ledger.beginAct("Adicione o fone ao carrinho");
    ledger.record(entry('clicou button "Adicionar Fone ao carrinho"', 0, 1));
    ledger.endAct("fp-1");
    ledger.beginAct("Confira o carrinho");
    const prior = ledger.prior("fp-1");
    expect(prior).toHaveLength(1);
    expect(prior[0].what).toBe('[feito num act anterior #1 "Adicione o fone ao carrinho"] clicou button "Adicionar Fone ao carrinho" — carrinho 0→1; a página é a mesma do fim daquele act');
    expect(prior[0]).toMatchObject({ previous: true, actNo: 1, cartBefore: 0, cartAfter: 1, pageChangedSince: false, changed: true });
  });

  it("diz quando a página mudou desde o fim do act anterior (só na última ação)", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record(entry("clicou link X"));
    ledger.record(entry("clicou button Y"));
    ledger.endAct("fp-fim");
    ledger.beginAct("b");
    const prior = ledger.prior("fp-outra");
    expect(prior[0].pageChangedSince).toBeNull();
    expect(prior[1].pageChangedSince).toBe(true);
    expect(prior[1].what).toContain("a página mudou desde o fim daquele act");
    expect(prior[0].what).not.toContain("a página");
  });

  it("antes de ler a página, a mudança é desconhecida (não afirma nada)", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record(entry("clicou X"));
    ledger.endAct("fp");
    ledger.beginAct("b");
    const [only] = ledger.prior(null);
    expect(only.pageChangedSince).toBeNull();
    expect(only.what).not.toMatch(/página (é a mesma|mudou)/);
  });

  it("as ações do act em curso não voltam como «anteriores»", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record(entry("clicou X"));
    expect(ledger.prior("fp")).toEqual([]);
  });

  it("guarda só as últimas 10, em ordem cronológica, atravessando vários acts", () => {
    const ledger = createLedger();
    for (let act = 1; act <= 3; act++) {
      ledger.beginAct(`act ${act}`);
      for (let i = 1; i <= 5; i++) ledger.record(entry(`a${act}.${i}`));
      ledger.endAct(`fp${act}`);
    }
    ledger.beginAct("quarto");
    expect(ledger.size()).toBe(LEDGER_SIZE);
    const prior = ledger.prior("fp3");
    expect(prior).toHaveLength(10);
    expect(prior[0].what).toContain("a2.1");
    expect(prior[9].what).toContain("a3.5");
  });

  it("um portal parado por mais de 30 min começa de novo (a página de então não é a de agora)", () => {
    let t = 0;
    const ledger = createLedger(() => t);
    ledger.beginAct("a");
    ledger.record(entry("clicou X"));
    ledger.endAct("fp");
    t += 31 * 60_000;
    ledger.beginAct("b");
    expect(ledger.prior("fp")).toEqual([]);
  });

  it("cartNote só fala quando a contagem mudou", () => {
    expect(cartNote(0, 1)).toBe("carrinho 0→1");
    expect(cartNote(2, 2)).toBe("");
    expect(cartNote(null, 1)).toBe("");
  });
});

/** Uma página-carrinho do piloto: o texto diz quantos itens há. */
const page = (count: number, extra = "") => [
  'page: "Loja" https://shop.test/p', "viewport: 1920×1080 · scroll 0/900", "",
  "- main", '  - heading "Fone Bluetooth"', `  - text "Carrinho: ${count === 0 ? "vazio" : `${count} item`}"`,
  '  - button "Adicionar Fone Bluetooth ao carrinho" [ref=e1]', extra,
].filter(Boolean).join("\n");

function fakeHost(pages: string[]): BrowserHost {
  let n = 0;
  const run = async (command: PageCommand) => {
    if (command.op === "snapshot") return pages[Math.min(n, pages.length - 1)];
    if (command.op === "click") { n += 1; return { clicked: "button" }; }
    return {};
  };
  return {
    viewId: "v-test", channel: { run }, proxyOrigin: () => null, targetOrigin: () => null,
    loadCount: () => 1, waitForLoad: async () => true,
  } as unknown as BrowserHost;
}

describe("pilotDeps + livro-razão: o sinal de idempotência do carrinho (3.4)", () => {
  it("add ao carrinho num act: o seguinte vê «carrinho 0→1» e a página igual, para não adicionar de novo", async () => {
    const host = fakeHost([page(0), page(1)]);
    const ledger = createLedger();

    ledger.beginAct("Adicione o fone");
    const first = pilotDeps(host, [], ledger);
    await first.snapshot();
    await first.click("e1", false);
    const after = await first.snapshot();
    first.finish(after);

    ledger.beginAct("Adicione o fone ao carrinho"); // o agente repete o pedido
    const second = pilotDeps(host, [], ledger);
    // Antes de ler a página, o histórico já está lá; se a página mudou, ainda não se sabe.
    expect(second.prior()[0]).toMatchObject({ cartBefore: 0, cartAfter: 1, pageChangedSince: null });
    await second.snapshot();
    const [entry] = second.prior();
    expect(entry.what).toContain("carrinho 0→1");
    expect(entry.what).toContain("a página é a mesma do fim daquele act");
    expect(entry.pageChangedSince).toBe(false);
  });

  it("se a página mudou entre os acts, o histórico diz isso", async () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    const first = pilotDeps(fakeHost([page(0), page(1)]), [], ledger);
    await first.snapshot();
    await first.click("e1", false);
    first.finish(await first.snapshot());

    ledger.beginAct("b");
    const second = pilotDeps(fakeHost([page(1, '  - link "Outra coisa" [ref=e2] → /x')]), [], ledger);
    await second.snapshot();
    expect(second.prior()[0].pageChangedSince).toBe(true);
  });

  it("guarda o que estava ao lado do botão (produto e preço) para distinguir dois «Adicionar» iguais", async () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    const first = pilotDeps(fakeHost([page(0), page(1)]), [], ledger);
    await first.snapshot();
    await first.click("e1", false);
    first.finish(await first.snapshot());
    ledger.beginAct("b");
    const [entry] = ledger.prior(null);
    expect(entry.near).toContain("Fone Bluetooth");
  });

  it("um act que falhou no meio deixa a ação que já fez no livro-razão", async () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    const first = pilotDeps(fakeHost([page(0), page(1)]), [], ledger);
    await first.snapshot();
    await first.click("e1", false);
    first.finish(null); // o piloto caiu antes de reler a página
    ledger.beginAct("b");
    expect(ledger.prior(null)).toHaveLength(1);
    expect(ledger.prior(null)[0].changed).toBeNull();
  });
});

describe("portalLedger: histórico que não vale mais não volta (regressão L07/L17 do benchmark real)", () => {
  const add = (url: string, urlAfter = url) => ({ what: 'clicou button "Adicionar ao carrinho"', changed: true as boolean | null, cartBefore: 0, cartAfter: 1, url, urlAfter });

  it("uma ação feita em OUTRA página (outra tarefa no mesmo portal) não volta como «já adicionado»", () => {
    const ledger = createLedger();
    ledger.beginAct("Adicione o fone, sem garantia");
    ledger.record(add("http://localhost:8765/garantia.html"));
    ledger.endAct("fp");
    ledger.beginAct("Adicione o Fone Bluetooth.");
    expect(ledger.prior("fp2", { url: "http://localhost:8765/comprar-agora.html", cart: 0 })).toEqual([]);
  });

  it("a mesma página recarregada (carrinho de volta a 0) também não: o item já não está lá", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record(add("http://localhost:8765/garantia.html"));
    ledger.endAct("fp-com-1");
    ledger.beginAct("a de novo");
    expect(ledger.prior("fp-zerado", { url: "http://localhost:8765/garantia.html", cart: 0 })).toEqual([]);
  });

  it("a mesma página ainda com o item no carrinho continua valendo (o caso do T5 original)", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record(add("http://shop.test/p/fone"));
    ledger.endAct("fp");
    ledger.beginAct("b");
    const prior = ledger.prior("fp", { url: "http://shop.test/p/fone", cart: 1 });
    expect(prior).toHaveLength(1);
    expect(prior[0]).toMatchObject({ cartBefore: 0, cartAfter: 1, pageChangedSince: false });
  });

  it("sem saber o carrinho de agora, mantém (não apaga o que pode valer)", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record(add("http://shop.test/p/fone"));
    ledger.endAct("fp");
    ledger.beginAct("b");
    expect(ledger.prior("fp", { url: "http://shop.test/p/fone", cart: null })).toHaveLength(1);
  });

  it("a ação que navegou vale tanto na página de onde saiu quanto na de chegada; consulta e fragmento não contam", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record({ what: 'clicou link "Fone"', changed: true, cartBefore: null, cartAfter: null, url: "http://shop.test/busca?q=fone", urlAfter: "http://shop.test/p/fone#specs" });
    ledger.endAct("fp");
    ledger.beginAct("b");
    expect(ledger.prior("fp", { url: "http://shop.test/p/fone?ref=1", cart: null })).toHaveLength(1);
    expect(ledger.prior("fp", { url: "http://shop.test/busca", cart: null })).toHaveLength(1);
    expect(ledger.prior("fp", { url: "http://shop.test/outra", cart: null })).toEqual([]);
  });

  it("ações sem carrinho (digitar, clicar num link) na mesma página não são apagadas pela contagem", () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    ledger.record({ what: 'digitou em searchbox "Buscar"', changed: true, cartBefore: null, cartAfter: null, url: "http://shop.test/", urlAfter: "http://shop.test/" });
    ledger.endAct("fp");
    ledger.beginAct("b");
    expect(ledger.prior("fp", { url: "http://shop.test/", cart: 0 })).toHaveLength(1);
  });
});

describe("pilotDeps + livro-razão: o portal reaproveitado entre tarefas (L07 → L17)", () => {
  it("o act da loja B, com carrinho vazio, não recebe o «adicionar» da loja A", async () => {
    const ledger = createLedger();
    ledger.beginAct("Adicione o Fone na loja A");
    const a = pilotDeps(fakeHost([page(0), page(1)]), [], ledger);
    await a.snapshot();
    await a.click("e1", false);
    a.finish(await a.snapshot());

    ledger.beginAct("Adicione o Fone na loja B");
    const hostB = fakeHost([page(0).replace("https://shop.test/p", "https://outra.test/fone")]);
    const b = pilotDeps(hostB, [], ledger);
    await b.snapshot();
    expect(b.prior()).toEqual([]);
  });

  it("a mesma loja recarregada (carrinho 0 de novo) também não", async () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    const a = pilotDeps(fakeHost([page(0), page(1)]), [], ledger);
    await a.snapshot();
    await a.click("e1", false);
    a.finish(await a.snapshot());
    ledger.beginAct("a de novo");
    const again = pilotDeps(fakeHost([page(0)]), [], ledger);
    await again.snapshot();
    expect(again.prior()).toEqual([]);
  });

  it("a mesma página com o item ainda no carrinho mantém o histórico (não pode adicionar duas vezes)", async () => {
    const ledger = createLedger();
    ledger.beginAct("a");
    const a = pilotDeps(fakeHost([page(0), page(1)]), [], ledger);
    await a.snapshot();
    await a.click("e1", false);
    a.finish(await a.snapshot());
    ledger.beginAct("b");
    const b = pilotDeps(fakeHost([page(1)]), [], ledger);
    await b.snapshot();
    expect(b.prior()).toHaveLength(1);
  });
});
