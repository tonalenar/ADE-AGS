import { describe, expect, it } from "vitest";

import ptBR from "@/i18n/locales/pt-BR.json";

import {
  appendToDraft,
  buildExcerpt,
  destinationLabel,
  excerptPillPosition,
  fenceFor,
  PILL,
  selectionLines,
  selectionTextLines,
  type Translate,
} from "../terminalExcerpt";

/** O `t` com o catálogo pt-BR de verdade: o teste confere também o texto que a pessoa vê. */
const catalog = ptBR as Record<string, string>;
const t: Translate = (key, options = {}) =>
  (catalog[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));

describe("selectionLines", () => {
  const rows = (texts: Record<number, string>) => (y: number) => texts[y] ?? "texto";

  it("devolve as linhas absolutas do buffer, a partir de 1", () => {
    expect(selectionLines({ start: { x: 4, y: 29 }, end: { x: 10, y: 41 } }, rows({}))).toEqual({ from: 30, to: 42 });
  });

  it("não conta a linha onde a seleção termina na coluna 0", () => {
    expect(selectionLines({ start: { x: 0, y: 9 }, end: { x: 0, y: 12 } }, rows({}))).toEqual({ from: 10, to: 12 });
  });

  it("corta as linhas em branco do fim", () => {
    expect(selectionLines({ start: { x: 0, y: 0 }, end: { x: 20, y: 5 } }, rows({ 4: "   ", 5: "" }))).toEqual({ from: 1, to: 4 });
  });

  it("aceita uma seleção feita de baixo para cima e uma linha só", () => {
    expect(selectionLines({ start: { x: 8, y: 7 }, end: { x: 2, y: 3 } }, rows({}))).toEqual({ from: 4, to: 8 });
    expect(selectionLines({ start: { x: 2, y: 7 }, end: { x: 9, y: 7 } }, rows({ 7: "" }))).toEqual({ from: 8, to: 8 });
  });
});

describe("selectionTextLines", () => {
  it("troca CRLF por LF e corta só as linhas em branco do fim", () => {
    expect(selectionTextLines("  a\r\n\r\nb  \r\n\r\n   \r\n")).toEqual(["  a", "", "b  "]);
  });
});

describe("fenceFor", () => {
  it("usa três crases, ou uma a mais que as do trecho", () => {
    expect(fenceFor("nada")).toBe("```");
    expect(fenceFor("um `x` aqui")).toBe("```");
    expect(fenceFor("```ts\ncode\n```")).toBe("````");
  });
});

describe("buildExcerpt", () => {
  it("monta cabeçalho com a origem e as linhas, e o bloco de código", () => {
    const out = buildExcerpt({ source: "Claude Code — app", text: "erro: x\r\n  em y\r\n\r\n", from: 30, to: 42 }, t);
    expect(out).toEqual({
      text: "[Trecho de «Claude Code — app», linhas 30–42]\n```\nerro: x\n  em y\n```",
      truncated: false,
    });
  });

  it("diz \"linha\" quando é uma só", () => {
    expect(buildExcerpt({ source: "bash", text: "ok", from: 7, to: 7 }, t)?.text.split("\n")[0]).toBe("[Trecho de «bash», linha 7]");
  });

  it("devolve null para uma seleção só de espaços", () => {
    expect(buildExcerpt({ source: "x", text: "  \n \n", from: 1, to: 2 }, t)).toBeNull();
  });

  it("corta pelo número de linhas e avisa", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
    const out = buildExcerpt({ source: "x", text, from: 1, to: 10 }, t, { maxLines: 3, maxBytes: 1000 });
    expect(out?.truncated).toBe(true);
    expect(out?.text).toBe("[Trecho de «x», linhas 1–10]\n```\nl1\nl2\nl3\n```\n[… trecho cortado: limite de 3 linhas ou 1 KB]");
  });

  it("corta pelo tamanho sem partir caracteres", () => {
    const out = buildExcerpt({ source: "x", text: "ação ação ação", from: 1, to: 1 }, t, { maxLines: 400, maxBytes: 7 });
    expect(out?.truncated).toBe(true);
    expect(out?.text.split("\n")[2]).toBe("ação ");
    const lines = buildExcerpt({ source: "x", text: "aaaa\nbbbb\ncccc", from: 1, to: 3 }, t, { maxLines: 400, maxBytes: 9 });
    expect(lines?.text.split("\n").slice(2, 4)).toEqual(["aaaa", "bbbb"]);
  });

  it("usa uma cerca maior quando o trecho tem crases", () => {
    const out = buildExcerpt({ source: "x", text: "```\nx\n```", from: 1, to: 3 }, t);
    expect(out?.text.split("\n")[1]).toBe("````");
    expect(out?.text.endsWith("\n````")).toBe(true);
  });
});

describe("appendToDraft", () => {
  it("põe o trecho no fim com espaço para a pergunta", () => {
    expect(appendToDraft("", "B")).toBe("B\n\n");
    expect(appendToDraft("Olha isto:  \n", "B")).toBe("Olha isto:\n\nB\n\n");
  });
});

describe("destinationLabel", () => {
  it("põe o agente na frente só quando o título não o diz", () => {
    expect(destinationLabel({ title: "Claude Code — app", agentLabel: "Claude Code" })).toBe("Claude Code — app");
    expect(destinationLabel({ title: "Revisor", agentLabel: "Codex" })).toBe("Codex · Revisor");
    expect(destinationLabel({ title: "Revisor" })).toBe("Revisor");
  });
});

describe("excerptPillPosition", () => {
  const base = {
    rows: 20, cols: 80, cell: { width: 8, height: 16 },
    origin: { left: 12, top: 8 }, box: { width: 700, height: 400 },
  };

  it("fica logo abaixo do fim da seleção, na coluna dele", () => {
    expect(excerptPillPosition({ ...base, startRow: 2, endRow: 4, endCol: 10 })).toEqual({ left: 12 + 80, top: 8 + 5 * 16 + PILL.gap });
  });

  it("sem espaço embaixo, vai para cima do começo", () => {
    const pos = excerptPillPosition({ ...base, startRow: 10, endRow: 19, endCol: 0, box: { width: 700, height: 340 } });
    expect(pos).toEqual({ left: 12, top: 8 + 10 * 16 - PILL.height - PILL.gap });
  });

  it("não sai pela direita", () => {
    expect(excerptPillPosition({ ...base, startRow: 0, endRow: 0, endCol: 80 })?.left).toBe(700 - PILL.width - PILL.gap);
  });

  it("some quando a seleção está fora da tela", () => {
    expect(excerptPillPosition({ ...base, startRow: -10, endRow: -1, endCol: 3 })).toBeNull();
    expect(excerptPillPosition({ ...base, startRow: 20, endRow: 25, endCol: 3 })).toBeNull();
  });

  it("com a seleção passando do fim da tela, prende na última linha", () => {
    expect(excerptPillPosition({ ...base, startRow: 1, endRow: 40, endCol: 2, box: { width: 700, height: 600 } })?.top).toBe(8 + 20 * 16 + PILL.gap);
  });
});
