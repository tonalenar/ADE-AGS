// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { formatSnapshot, omittedLine } from "../page/snapshotFormat";
import { loadRuntime } from "./runtimeHarness";

const META = { url: "http://x/", title: "T", viewport: { width: 100, height: 100 }, scrollY: 0, documentHeight: 100 };

describe("estados completos no snapshot (O6)", () => {
  it("checked / unchecked / mixed em checkbox, radio, switch e aria", async () => {
    const h = await loadRuntime(`
      <input type="checkbox" aria-label="A" checked>
      <input type="checkbox" aria-label="B">
      <input type="radio" name="r" aria-label="C" checked>
      <input type="radio" name="r" aria-label="D">
      <div role="switch" aria-checked="true" aria-label="E" tabindex="0"></div>
      <div role="switch" aria-checked="false" aria-label="F" tabindex="0"></div>
      <div role="checkbox" aria-checked="mixed" aria-label="G" tabindex="0"></div>`);
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/checkbox "A" \[ref=e1\] \[checked\]/);
    expect(snap).toMatch(/checkbox "B" \[ref=e2\] \[unchecked\]/);
    expect(snap).toMatch(/radio "C" \[ref=e3\] \[checked\]/);
    expect(snap).toMatch(/radio "D" \[ref=e4\] \[unchecked\]/);
    expect(snap).toMatch(/switch "E" \[ref=e5\] \[checked\]/);
    expect(snap).toMatch(/switch "F" \[ref=e6\] \[unchecked\]/);
    expect(snap).toMatch(/checkbox "G" \[ref=e7\] \[mixed\]/);
    expect(snap).not.toMatch(/"G".*\[unchecked\]/);
  });

  it("expanded / collapsed em aria-expanded e em <summary> de <details>", async () => {
    const h = await loadRuntime(`
      <button aria-expanded="true">Menu aberto</button>
      <button aria-expanded="false">Menu fechado</button>
      <details open><summary>Detalhes abertos</summary><p>x</p></details>
      <details><summary>Detalhes fechados</summary><p>y</p></details>`);
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/"Menu aberto" \[ref=e1\] \[expanded\]/);
    expect(snap).toMatch(/"Menu fechado" \[ref=e2\] \[collapsed\]/);
    expect(snap).toMatch(/"Detalhes abertos" \[ref=e3\] \[expanded\]/);
    expect(snap).toMatch(/"Detalhes fechados" \[ref=e4\] \[collapsed\]/);
  });

  it("selected, current, busy e pressed", async () => {
    const h = await loadRuntime(`
      <div role="tablist">
        <button role="tab" aria-selected="true">Aba 1</button>
        <button role="tab" aria-selected="false">Aba 2</button>
      </div>
      <a href="/p/2" aria-current="page">Página 2</a>
      <a href="/p/3" aria-current="false">Página 3</a>
      <button aria-pressed="true">Negrito</button>
      <button aria-pressed="mixed">Itálico</button>
      <button aria-busy="true">Salvando</button>`);
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/tab "Aba 1" \[ref=e1\] \[selected\]/);
    expect(snap).not.toMatch(/"Aba 2".*\[selected\]/);
    expect(snap).toMatch(/"Página 2" \[ref=e3\] \[current\]/);
    expect(snap).not.toMatch(/"Página 3".*\[current\]/);
    expect(snap).toMatch(/"Negrito" \[ref=e5\] \[pressed\]/);
    expect(snap).toMatch(/"Itálico" \[ref=e6\] \[mixed\]/);
    expect(snap).toMatch(/"Salvando" \[ref=e7\] \[busy\]/);
  });

  it("um campo dentro de <fieldset disabled> também sai como disabled", async () => {
    const h = await loadRuntime(`<fieldset disabled><input aria-label="Nome"></fieldset><input aria-label="Livre">`);
    const snap = String(await h.run({ op: "snapshot" }));
    expect(snap).toMatch(/"Nome" \[ref=e1\] \[disabled\]/);
    expect(snap).not.toMatch(/"Livre".*\[disabled\]/);
  });
});

describe("contagem de omitidos (O6)", () => {
  it("passou do limite de nós: o snapshot diz quantos ficaram fora e quantos eram controles", async () => {
    const buttons = Array.from({ length: 650 }, (_, i) => `<button>B${i}</button>`).join("");
    const h = await loadRuntime(`<main>${buttons}</main>`);
    const snap = String(await h.run({ op: "snapshot" }));
    // 1 nó é o <main>; o limite é 600 → 51 botões ficam de fora.
    expect(snap).toMatch(/… 51 nós além do limite de 600 \(peça o snapshot completo; 51 são controles\)/);
    expect(snap).not.toMatch(/fora da janela/);
  });

  it("o snapshot completo traz todos e não tem linha de omitidos", async () => {
    const buttons = Array.from({ length: 650 }, (_, i) => `<button>B${i}</button>`).join("");
    const h = await loadRuntime(`<main>${buttons}</main>`);
    const snap = String(await h.run({ op: "snapshot", all: true }));
    expect(snap).not.toMatch(/…/);
  });

  it("a linha separa fora da janela de além do limite", () => {
    expect(omittedLine({ omitted: 25, outOfView: 25, overLimit: 0, outOfViewControls: 7, overLimitControls: 0 }))
      .toBe("… 25 nós fora da janela (role para ver; 7 são controles)");
    expect(omittedLine({ omitted: 31, outOfView: 1, overLimit: 30, outOfViewControls: 1, overLimitControls: 0, limit: 600 }))
      .toBe("… 1 nós fora da janela (role para ver; 1 é controle) · 30 nós além do limite de 600 (peça o snapshot completo)");
  });

  it("sem detalhe (meta montada à mão), a contagem total; sem omitidos, nenhuma linha", () => {
    expect(omittedLine({ omitted: 9 })).toBe("… 9 nós omitidos (peça o snapshot completo ou role a página)");
    expect(formatSnapshot([], { ...META, omitted: 0 })).not.toContain("…");
  });
});
