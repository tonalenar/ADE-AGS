import { describe, expect, it } from "vitest";

import { rejectCurrencyMath } from "@/shared/ui/markdownMath";

const math = (value: string) => ({ type: "inlineMath", value });
const text = (value: string) => ({ type: "text", value });

/** As regras do cifrão (Pandoc, como no T3 Code) sobre a árvore que o remark-math devolve. */
describe("regra do cifrão sobre a matemática do Markdown", () => {
  it("uma fórmula bem fechada continua fórmula", () => {
    const paragraph = { type: "paragraph", children: [text("A área é "), math("x^2"), text(" aqui.")] };
    rejectCurrencyMath(paragraph);
    expect(paragraph.children[1]).toEqual(math("x^2"));
  });

  it("espaço colado ao cifrão de fechamento ou de abertura devolve o trecho a texto", () => {
    const closing = { type: "paragraph", children: [math("5 e ")] };
    rejectCurrencyMath(closing);
    expect(closing.children).toEqual([text("$5 e $")]);

    const opening = { type: "paragraph", children: [math(" x")] };
    rejectCurrencyMath(opening);
    expect(opening.children).toEqual([text("$ x$")]);
  });

  it("um cifrão de fechamento seguido de dígito não fecha fórmula", () => {
    const paragraph = { type: "paragraph", children: [math("5 e "), text("10 hoje.")] };
    rejectCurrencyMath(paragraph);
    expect(paragraph.children).toEqual([text("$5 e $"), text("10 hoje.")]);
  });

  it("alcança os filhos aninhados e não toca no que não é fórmula", () => {
    const paragraph = { type: "paragraph", children: [{ type: "strong", children: [math("1 ")] }, text(" ok")] };
    rejectCurrencyMath(paragraph);
    expect(paragraph.children).toEqual([{ type: "strong", children: [text("$1 $")] }, text(" ok")]);
  });
});
