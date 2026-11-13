import { describe, expect, it } from "vitest";

import { expandBraces, mentionedImages } from "../attachments/mediaViewerModel";

const cwd = "/proj/app";

describe("mentionedImages", () => {
  it("acha imagens em código inline, inclusive em tabela, e em links", () => {
    const text = [
      "| Arquivo | Como ficou |",
      "|---|---|",
      "| `brand/mascote/gostin-mascote-base.png` | ok |",
      "Veja [o logo](brand/logo/gostin-logo-horizontal.png) e `src/main.ts`.",
    ].join("\n");
    expect(mentionedImages(text, cwd).map((i) => i.path)).toEqual([
      "/proj/app/brand/logo/gostin-logo-horizontal.png",
      "/proj/app/brand/mascote/gostin-mascote-base.png",
    ]);
  });

  it("expande chaves simples", () => {
    expect(mentionedImages("`a/degrau-{ver,cheirar}.png`", cwd).map((i) => i.name)).toEqual(["degrau-ver.png", "degrau-cheirar.png"]);
    expect(expandBraces("x-{a,{b}}.png")).toEqual([]);
  });

  it("recusa caminhos fora da pasta, URLs remotas e blocos de código", () => {
    const text = "`../../etc/x.png` `/outra/y.png` [r](https://site.com/z.png)\n```\n`dentro/bloco.png`\n```";
    expect(mentionedImages(text, cwd)).toEqual([]);
    expect(mentionedImages("`a.png`", null)).toEqual([]);
  });

  it("não repete imagens já mostradas com ![]()", () => {
    expect(mentionedImages("![m](brand/a.png) e `brand/a.png`", cwd)).toEqual([]);
  });

  it("aceita caminho absoluto dentro da pasta", () => {
    expect(mentionedImages("`/proj/app/shots/tela.webp`", cwd).map((i) => i.path)).toEqual(["/proj/app/shots/tela.webp"]);
  });
});
