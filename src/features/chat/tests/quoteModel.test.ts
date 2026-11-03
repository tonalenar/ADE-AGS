import { describe, expect, it } from "vitest";

import { addQuote, clipQuote, MAX_QUOTES, MAX_QUOTE_CHARS, quoteBlock, splitQuotes, withQuotes, type Quote } from "../quotes/quoteModel";

const q = (text: string, comment: string): Quote => ({ id: `${text}|${comment}`, text, comment });

describe("o bloco de citação que vai no texto (claro para qualquer motor)", () => {
  it("cada citação é `> trecho` e o comentário, uma linha por linha", () => {
    expect(quoteBlock([q("linha um\nlinha dois", "mude isto\ne aquilo")])).toBe("[Citação]\n> linha um\n> linha dois\n| mude isto\n| e aquilo");
  });

  it("várias citações ficam uma depois da outra", () => {
    expect(quoteBlock([q("a", "x"), q("b", "y")])).toBe("[Citação]\n> a\n| x\n[Citação]\n> b\n| y");
  });

  it("sem citações não há bloco", () => {
    expect(quoteBlock([])).toBe("");
  });

  it("vai depois do texto da pessoa, separado por uma linha em branco (a menção `@agente` no começo continua valendo)", () => {
    expect(withQuotes("@codex revise", [q("trecho", "ok?")])).toBe("@codex revise\n\n[Citação]\n> trecho\n| ok?");
    expect(withQuotes("", [q("trecho", "ok?")])).toBe("[Citação]\n> trecho\n| ok?");
    expect(withQuotes("oi", [])).toBe("oi");
  });
});

describe("ler a citação de volta (a bolha mostra o cartão, sem o texto cru)", () => {
  it("devolve o texto da pessoa e as citações com o comentário", () => {
    const text = withQuotes("veja isto", [q("primeira\nsegunda", "comentário\ncom duas linhas"), q("outra", "mais um")]);
    expect(splitQuotes(text)).toEqual({
      text: "veja isto",
      quotes: [{ text: "primeira\nsegunda", comment: "comentário\ncom duas linhas" }, { text: "outra", comment: "mais um" }],
    });
  });

  it("só citação, sem texto: o texto volta vazio", () => {
    expect(splitQuotes(withQuotes("", [q("a", "b")]))).toEqual({ text: "", quotes: [{ text: "a", comment: "b" }] });
  });

  it("texto comum, ou com um `>` de markdown solto, passa intacto", () => {
    expect(splitQuotes("oi")).toEqual({ text: "oi", quotes: [] });
    expect(splitQuotes("veja:\n> isto é uma citação de markdown")).toEqual({ text: "veja:\n> isto é uma citação de markdown", quotes: [] });
  });

  it("linhas de citação que ANTECEDEM o bloco continuam sendo texto da pessoa", () => {
    const text = `lista:\n> item de markdown\n\n${quoteBlock([q("a", "b")])}`;
    expect(splitQuotes(text).text).toBe("lista:\n> item de markdown");
  });

  it("convive com o bloco de anexos (que já foi tirado antes) e com o texto depois do resumo da troca de agente", () => {
    expect(splitQuotes(`texto\n\n${quoteBlock([q("a", "b")])}\n`).quotes).toHaveLength(1);
  });
});

describe("limites e repetição", () => {
  it("o trecho é cortado no limite, dizendo que cortou, e o espaço sobrando sai", () => {
    expect(clipQuote("  um   trecho \n\n\ncurto  ")).toBe("um   trecho\n\ncurto");
    const long = clipQuote("x".repeat(MAX_QUOTE_CHARS + 50));
    expect(long.length).toBe(MAX_QUOTE_CHARS + 1);
    expect(long.endsWith("…")).toBe(true);
  });

  it("a mesma citação com o mesmo comentário não entra duas vezes; há um máximo", () => {
    const once = addQuote([], { text: "a", comment: "b" });
    expect(addQuote(once, { text: "a", comment: "b" })).toHaveLength(1);
    let list: Quote[] = [];
    for (let i = 0; i < MAX_QUOTES + 3; i++) list = addQuote(list, { text: `t${i}`, comment: "c" });
    expect(list).toHaveLength(MAX_QUOTES);
  });

  it("recusa citação sem trecho ou sem comentário", () => {
    expect(addQuote([], { text: "   ", comment: "x" })).toEqual([]);
    expect(addQuote([], { text: "a", comment: "  " })).toEqual([]);
  });
});
