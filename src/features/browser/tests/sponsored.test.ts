// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { findSponsoredBlocks, inSponsored } from "../page/sponsored";
import { loadRuntime } from "./runtimeHarness";

/** As ids dos elementos que ficam dentro de um bloco de anúncio. */
function sponsoredIds(html: string): string[] {
  document.body.innerHTML = html;
  const blocks = findSponsoredBlocks(document);
  const memo = new Map<Element, boolean>();
  return Array.from(document.querySelectorAll("[id]")).filter((el) => inSponsored(el, blocks, memo)).map((el) => el.id);
}

describe("findSponsoredBlocks: o que é anúncio (O2)", () => {
  it("data-component-type da Amazon", () => {
    expect(sponsoredIds(`<div data-component-type="sp-sponsored-result"><a id="ad" href="/a">Caneca</a></div><div data-component-type="s-search-result"><a id="org" href="/b">Outra</a></div>`)).toEqual(["ad"]);
  });

  it("aria-label «Patrocinado», «Sponsored», «Anúncio» e «Ad» no começo", () => {
    for (const label of ["Patrocinado", "Sponsored", "Anúncio", "Ad", "Sponsored result: Caneca", "Patrocinado - Loja X"]) {
      expect(sponsoredIds(`<div aria-label="${label}"><a id="ad" href="/a">x</a></div><div><a id="org" href="/b">y</a></div>`), label).toEqual(["ad"]);
    }
  });

  it("«Adicionar ao carrinho» e «Adoro» não são anúncio", () => {
    expect(sponsoredIds(`<button id="b" aria-label="Adicionar Teclado ao carrinho">Adicionar</button><a id="l" aria-label="Adoro café" href="/c">c</a>`)).toEqual([]);
  });

  it("classes que dizem patrocinado/sponsored/adsbygoogle", () => {
    expect(sponsoredIds(`<li class="ui-search-layout__item sponsored-card"><a id="ad" href="/a">x</a></li><li class="ui-search-layout__item"><a id="org" href="/b">y</a></li>`)).toEqual(["ad"]);
    expect(sponsoredIds(`<ins class="adsbygoogle"><a id="ad" href="/a">x</a></ins>`)).toEqual(["ad"]);
  });

  it("data-sponsored / data-testid com sponsored; data-sponsored=false não conta", () => {
    expect(sponsoredIds(`<article data-sponsored="true"><a id="a1" href="/1">x</a></article><article data-testid="product-sponsored-tag"><a id="a2" href="/2">y</a></article><article data-sponsored="false"><a id="o" href="/3">z</a></article>`)).toEqual(["a1", "a2"]);
  });

  it("um rótulo de texto «Patrocinado» marca o cartão que o contém, sem marcar os vizinhos", () => {
    const html = `<ul>
      <li><div><span>Patrocinado</span></div><h3><a id="ad" href="/a">Caneca Térmica</a></h3><span>R$ 39</span></li>
      <li><h3><a id="org" href="/b">Caneca de Cerâmica</a></h3><span>R$ 29</span></li>
    </ul>`;
    expect(sponsoredIds(html)).toEqual(["ad"]);
  });

  it("o rótulo do fixture (small dentro de um div) e «Sponsored · Marca»", () => {
    expect(sponsoredIds(`<div><small>Patrocinado</small><p><a id="ad" href="/a">Caneca</a></p></div><div><p><a id="org" href="/b">Outra</a></p></div>`)).toEqual(["ad"]);
    expect(sponsoredIds(`<div><span>Sponsored · Acme</span><a id="ad" href="/a">x</a></div><div><a id="org" href="/b">y</a></div>`)).toEqual(["ad"]);
  });

  it("um texto que só começa com a palavra («Ads manager», «Anúncios da loja») não é rótulo", () => {
    expect(sponsoredIds(`<nav><div><span>Ads manager</span><a id="n" href="/n">Painel</a></div></nav>`)).toEqual([]);
  });

  it("main, body, nav e form nunca viram um bloco de anúncio inteiro", () => {
    expect(sponsoredIds(`<main aria-label="Anúncio"><a id="x" href="/x">x</a></main>`)).toEqual([]);
    expect(sponsoredIds(`<main><section><span>Patrocinado</span></section><a id="x" href="/x">tudo</a></main>`).includes("x")).toBe(false);
  });

  it("um bloco só-pelo-rótulo grande demais é ignorado", () => {
    const big = "texto ".repeat(700);
    expect(sponsoredIds(`<div><span>Patrocinado</span><p>${big}</p><a id="x" href="/x">x</a></div>`)).toEqual([]);
  });
});

describe("snapshot: o estado [patrocinado] chega ao agente (O2)", () => {
  it("o resultado patrocinado ganha a marca; o orgânico, não (fixture anuncios-busca)", async () => {
    const h = await loadRuntime(`
      <main><h1>Resultados para: caneca</h1>
        <div data-component-type="sp-sponsored-result" aria-label="Patrocinado"><small>Patrocinado</small><p><a href="?p=termica">Caneca Térmica Premium</a> R$ 39,90</p></div>
        <div data-component-type="s-search-result"><p><a href="?p=ceramica">Caneca de Cerâmica Branca</a> R$ 39,90</p></div>
      </main>`);
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/link "Caneca Térmica Premium" \[ref=e1\] \[patrocinado\]/);
    expect(snap).toMatch(/link "Caneca de Cerâmica Branca" \[ref=e2\](?! \[patrocinado\])/);
  });

  it("os botões do anúncio da grade também (fixture anuncios-carrinho)", async () => {
    const h = await loadRuntime(`
      <main><h1>Fones de ouvido</h1>
        <div data-component-type="sp-sponsored-result" aria-label="Patrocinado"><small>Patrocinado</small><h2>Fone Gamer RGB</h2><button aria-label="Adicionar Fone Gamer RGB ao carrinho">Adicionar ao carrinho</button></div>
        <div><h2>Fone Bluetooth Lite</h2><button aria-label="Adicionar Fone Bluetooth Lite ao carrinho">Adicionar ao carrinho</button></div>
      </main>`);
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/Fone Gamer RGB ao carrinho" \[ref=e1\] \[patrocinado\]/);
    expect(snap).not.toMatch(/Bluetooth Lite ao carrinho" \[ref=e2\] \[patrocinado\]/);
  });
});
