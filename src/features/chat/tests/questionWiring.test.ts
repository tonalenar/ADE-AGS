import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

describe("a conversa por protocolo liga a resposta ao cartão da pergunta", () => {
  it("só passa `onAnswer` ao fio enquanto há pergunta esperando, e ele responde o pedido aberto", () => {
    const source = read("../structured/StructuredConversationView.tsx");
    expect(source).toMatch(/onAnswer=\{question \? answer : undefined\}/);
    expect(source).toMatch(/const answer = \(choice: string\) => \{ if \(request\) answerRequest\(thread\.id, request\.id, choice\); \};/);
  });
});
