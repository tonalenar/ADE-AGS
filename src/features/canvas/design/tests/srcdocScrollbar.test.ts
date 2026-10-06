import { describe, expect, it } from "vitest";
import { SCROLLBAR_CSS, buildSrcdoc } from "../srcdoc";

describe("barras de rolagem do iframe da prancheta", () => {
  it("o srcdoc leva o CSS tematizado antes do HTML do agente", () => {
    const doc = buildSrcdoc("<p>oi</p>");
    expect(doc).toContain(SCROLLBAR_CSS);
    expect(doc.indexOf(SCROLLBAR_CSS)).toBeLessThan(doc.indexOf("<p>oi</p>"));
  });
  it("sem trilho, redondas e com hover", () => {
    expect(SCROLLBAR_CSS).toContain("::-webkit-scrollbar-track{background:transparent}");
    expect(SCROLLBAR_CSS).toContain("border-radius:999px");
    expect(SCROLLBAR_CSS).toContain("::-webkit-scrollbar-thumb:hover");
  });
  it("nao abre a CSP: so CSS inline, sem url() nem @import", () => {
    expect(SCROLLBAR_CSS).not.toMatch(/url\(|@import/);
  });
});
