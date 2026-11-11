import { describe, expect, it } from "vitest";

import { ISOLATED_FRAME_CSP } from "@/features/chat/timeline/isolatedFrame";

import { parseRenderMessage, renderProjectName, renderSrcdoc } from "../model";

describe("documento de uma página HTML publicada", () => {
  it("leva a CSP do quadro isolado, antes do HTML do agente", () => {
    const doc = renderSrcdoc("<h1>Vendas</h1>");
    expect(doc).toContain(`content="${ISOLATED_FRAME_CSP}"`);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<h1>Vendas</h1>"));
  });

  it("tira as metas de CSP e as bases que o próprio HTML tentar pôr", () => {
    const doc = renderSrcdoc('<meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://x.test/"><p>oi</p>');
    expect(doc.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(doc).not.toContain("https://x.test/");
    expect(doc).toContain("<p>oi</p>");
  });

  it("segue o tema claro ou escuro da ADE, com as cores que chegam validadas", () => {
    expect(renderSrcdoc("x", { dark: true, declarations: "--color-surface:#111" })).toContain(":root{--color-surface:#111;color-scheme:dark}");
    expect(renderSrcdoc("x", { dark: false, declarations: "--color-x:<script>" })).toContain(":root{;color-scheme:light}");
  });
});

describe("mensagem de link vinda da página", () => {
  it("aceita só o endereço http(s) da própria mensagem", () => {
    expect(parseRenderMessage({ source: "ags-render", kind: "open-link", href: "https://exemplo.com/a" })).toBe("https://exemplo.com/a");
  });

  it("recusa qualquer outra fonte, tipo ou esquema", () => {
    expect(parseRenderMessage({ source: "ags-mcp-app", kind: "open-link", href: "https://exemplo.com" })).toBeNull();
    expect(parseRenderMessage({ source: "ags-render", kind: "navigate", href: "https://exemplo.com" })).toBeNull();
    expect(parseRenderMessage({ source: "ags-render", kind: "open-link", href: "javascript:alert(1)" })).toBeNull();
    expect(parseRenderMessage({ source: "ags-render", kind: "open-link", href: "file:///etc/passwd" })).toBeNull();
    expect(parseRenderMessage("https://exemplo.com")).toBeNull();
    expect(parseRenderMessage(null)).toBeNull();
  });
});

describe("nome do projeto na lista", () => {
  it("usa a última pasta do caminho, em qualquer sistema", () => {
    expect(renderProjectName("/Users/ton/Projects/ADE-AGS/")).toBe("ADE-AGS");
    expect(renderProjectName("C:\\dev\\site")).toBe("site");
    expect(renderProjectName("")).toBe("");
  });
});
