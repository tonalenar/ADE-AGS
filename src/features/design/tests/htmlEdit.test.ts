// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { exportDocument, exportFileName, isVersionConflict, removeElement, replaceInner } from "../htmlEdit";

describe("edição do HTML da prancheta", () => {
  it("troca o conteúdo do elemento pelo seletor relativo ao body e mantém o estilo inicial", () => {
    const html = `<style>p{color:red}</style><div><p>um</p><p>dois</p></div>`;
    const r = replaceInner(html, "div:nth-of-type(1) > p:nth-of-type(2)", "<b>2</b>");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain("<style>p{color:red}</style>");
    expect(r.html).toContain("<p>um</p><p><b>2</b></p>");
    expect(r.html).not.toContain("<html");
  });

  it("limpa o contenteditable que volte do iframe", () => {
    const r = replaceInner("<h1>a</h1>", "h1:nth-of-type(1)", `<span contenteditable="true">b</span>`);
    expect(r.ok && r.html).toBe("<h1><span>b</span></h1>");
  });

  it("documento inteiro continua documento; elemento sumido não muda nada", () => {
    const doc = "<!doctype html><html><head><title>t</title></head><body><main><h1>x</h1></main></body></html>";
    const r = removeElement(doc, "main:nth-of-type(1) > h1:nth-of-type(1)");
    expect(r.ok && r.html.startsWith("<!doctype html>")).toBe(true);
    expect(r.ok && r.html).not.toContain("<h1>");
    expect(removeElement("<p>a</p>", "div#nada")).toEqual({ ok: false, reason: "missing" });
    expect(removeElement("<p>a</p>", "p::(")).toEqual({ ok: false, reason: "missing" });
  });

  it("exporta um documento completo com nome de arquivo seguro", () => {
    expect(exportDocument("<p>oi</p>", "Tela <1>")).toContain("<title>Tela &lt;1&gt;</title>");
    expect(exportDocument("<html><body/></html>", "t").startsWith("<!doctype html>")).toBe(true);
    expect(exportFileName("Tela Inicial / Login!", "html")).toBe("Tela-Inicial-Login.html");
    expect(exportFileName("???", "pdf")).toBe("prancheta.pdf");
    expect(isVersionConflict("Artboard changed; reload before editing")).toBe(true);
    expect(isVersionConflict("outro")).toBe(false);
  });
});
