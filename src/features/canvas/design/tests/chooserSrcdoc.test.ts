import { describe, expect, it } from "vitest";

import { CHOOSER_MODE, buildSrcdoc } from "../srcdoc";

describe("srcdoc da prancheta no modo Escolher", () => {
  it("não muda o HTML do iframe quando o modo escolher liga ou desliga", () => {
    const html = "<article><section>A</section><section>B</section></article>";
    expect(buildSrcdoc(html, { chooser: true })).toBe(buildSrcdoc(html, { chooser: false }));
    expect(buildSrcdoc(html, { chooser: true })).toBe(buildSrcdoc(html));
  });

  it("o script do chooser espera a mensagem do app, em vez de ir no srcdoc só no modo escolher", () => {
    const doc = buildSrcdoc("<p>x</p>");
    expect(doc).toContain(CHOOSER_MODE);
  });
});
