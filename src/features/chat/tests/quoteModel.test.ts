import { describe, expect, it } from "vitest";

import {
  addQuote,
  citationLabel,
  clipQuote,
  MAX_COMMENT_CHARS,
  MAX_QUOTE_CHARS,
  MAX_QUOTES,
  quoteBlock,
  resolveCommentDismissal,
  splitQuotes,
  updateQuoteComment,
  withQuotes,
  type Quote,
} from "../quotes/quoteModel";

const q = (text: string, comment = "", originItemId?: string): Quote => ({
  id: `${text}|${comment}`,
  text,
  comment,
  ...(originItemId ? { originItemId } : {}),
});

describe("o payload de citação enviado ao agente (equivalente ao T3 Code)", () => {
  it("gera <assistant_citations> com texto citado, comentário opcional e messageId escapados em JSON", () => {
    const payload = withQuotes("@codex revise <tag>", [
      q("linha um\n<script>", "mude isto & aquilo", "msg-42"),
    ]);
    expect(payload).toContain("@codex revise <tag>");
    expect(payload).toContain("[assistant-quote-1]");
    expect(payload).toContain("<assistant_citations>");
    expect(payload).toContain("</assistant_citations>");
    expect(payload).toContain("citation.comment is a user-authored request");
    expect(payload).toContain('"text": "linha um\\n\\u003cscript\\u003e"');
    expect(payload).toContain('"comment": "mude isto \\u0026 aquilo"');
    expect(payload).toContain('"messageId": "msg-42"');
  });

  it("sem comentário usa a descrição de excertos e omite o campo comment no JSON", () => {
    const payload = withQuotes("explica melhor", [q("trecho citado")]);
    expect(payload).toContain("The following excerpts were selected from earlier assistant responses.");
    expect(payload).not.toContain('"comment"');
    expect(payload).toContain('"text": "trecho citado"');
  });

  it("múltiplas citações são numeradas em sequência e sem citações não há bloco", () => {
    expect(quoteBlock([])).toBe("");
    expect(withQuotes("oi", [])).toBe("oi");
    const payload = withQuotes("veja", [q("a", "x"), q("b")]);
    expect(payload).toContain("[assistant-quote-1]");
    expect(payload).toContain("[assistant-quote-2]");
    expect(payload).toContain('"id": "assistant-quote-1"');
    expect(payload).toContain('"id": "assistant-quote-2"');
  });
});

describe("ler a citação de volta (novo formato T3 e formato legado [Citação])", () => {
  it("separa texto e citações do bloco <assistant_citations> (com e sem comentário)", () => {
    const raw = withQuotes("veja isto", [
      q("primeira\nsegunda", "comentário\ncom duas linhas", "item-1"),
      q("outra", "", "item-2"),
    ]);
    expect(splitQuotes(raw)).toEqual({
      text: "veja isto",
      quotes: [
        { text: "primeira\nsegunda", comment: "comentário\ncom duas linhas", originItemId: "item-1" },
        { text: "outra", comment: "", originItemId: "item-2" },
      ],
    });
  });

  it("só citação, sem texto digitado: o corpo volta vazio", () => {
    const raw = withQuotes("", [q("trecho", "ok?", "m1")]);
    expect(splitQuotes(raw)).toEqual({
      text: "",
      quotes: [{ text: "trecho", comment: "ok?", originItemId: "m1" }],
    });
  });

  it("mantém compatibilidade com o formato legado [Citação]", () => {
    const legacy = "@codex revise\n\n[Citação]\n> trecho\n| ok?";
    expect(splitQuotes(legacy)).toEqual({
      text: "@codex revise",
      quotes: [{ text: "trecho", comment: "ok?" }],
    });
  });

  it("texto comum, ou com um `>` de markdown solto, passa intacto", () => {
    expect(splitQuotes("oi")).toEqual({ text: "oi", quotes: [] });
    expect(splitQuotes("veja:\n> isto é uma citação de markdown")).toEqual({
      text: "veja:\n> isto é uma citação de markdown",
      quotes: [],
    });
  });

  it("linhas `>` antes de um bloco legado continuam sendo texto da pessoa", () => {
    const text = "lista:\n> item de markdown\n\n[Citação]\n> a\n| b";
    expect(splitQuotes(text).text).toBe("lista:\n> item de markdown");
  });
});

describe("limites, comentário opcional, edição e rótulo", () => {
  it("permite citação sem comentário, mas recusa trecho vazio e respeita limite", () => {
    expect(addQuote([], { text: "   " })).toEqual([]);
    const semComentario = addQuote([], { text: "trecho válido", originItemId: "a1" });
    expect(semComentario).toHaveLength(1);
    expect(semComentario[0]).toMatchObject({ text: "trecho válido", comment: "", originItemId: "a1" });

    let list: Quote[] = [];
    for (let i = 0; i < MAX_QUOTES + 3; i++) list = addQuote(list, { text: `t${i}` });
    expect(list).toHaveLength(MAX_QUOTES);
  });

  it("a mesma citação repetida não entra duas vezes e updateQuoteComment atualiza o comentário", () => {
    const once = addQuote([], { text: "a", comment: "" });
    expect(addQuote(once, { text: "a", comment: "" })).toHaveLength(1);
    const updated = updateQuoteComment(once, once[0]!.id, "  novo comentário  ");
    expect(updated[0]!.comment).toBe("novo comentário");
    const cleared = updateQuoteComment(updated, once[0]!.id, "   ");
    expect(cleared[0]!.comment).toBe("");
    const tooLong = updateQuoteComment(updated, once[0]!.id, "x".repeat(MAX_COMMENT_CHARS + 1));
    expect(tooLong[0]!.comment).toBe("novo comentário");
  });

  it("o trecho é cortado em MAX_QUOTE_CHARS (8000) e citationLabel trunca em 64 chars sem quebrar emoji", () => {
    expect(MAX_QUOTE_CHARS).toBe(8_000);
    expect(clipQuote("  um   trecho \n\n\ncurto  ")).toBe("um   trecho \n\ncurto".replace(" \n\n", "\n\n"));
    const long = clipQuote("x".repeat(MAX_QUOTE_CHARS + 50));
    expect(long.length).toBe(MAX_QUOTE_CHARS + 1);
    expect(long.endsWith("…")).toBe(true);
    expect(citationLabel({ text: `${"a".repeat(63)}😀 e mais`, comment: "" })).toBe(`${"a".repeat(63)}…`);
    expect(citationLabel({ text: "texto", comment: "  meu   comentário  " })).toBe("meu comentário");
  });

  it("resolveCommentDismissal salva rascunho ao clicar fora, fecha no Esc e mantém aberto acima do limite", () => {
    expect(resolveCommentDismissal({ reason: "outside-press", draft: "revisar", savedComment: "" })).toEqual({
      kind: "commit",
      comment: "revisar",
    });
    expect(resolveCommentDismissal({ reason: "escape-key", draft: "revisar", savedComment: "" })).toEqual({
      kind: "close",
    });
    expect(
      resolveCommentDismissal({
        reason: "outside-press",
        draft: "x".repeat(MAX_COMMENT_CHARS + 1),
        savedComment: "",
      }),
    ).toEqual({ kind: "keep-open" });
  });
});
