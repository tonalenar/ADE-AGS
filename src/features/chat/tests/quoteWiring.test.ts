import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

describe("«Citar» está ligado às duas conversas (protocolo e TUI) igual ao T3 Code", () => {
  it("o composer e a lista de cada conversa usam a mesma chave (o cartão da sidebar)", () => {
    for (const file of ["../ConversationView.tsx", "../structured/StructuredConversationView.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("quoteKey={card.tabId}");
      expect(source.match(/quoteKey=\{card\.tabId\}/g)?.length, file).toBe(2);
    }
  });

  it("apenas as falas do assistente são citáveis no chat (como no T3 Code); o composer e as falas do usuário não", () => {
    expect(read("../timeline/Bubbles.tsx").match(/data-quotable=""/g)?.length).toBe(1);
    expect(read("../ChatComposer.tsx")).not.toContain("data-quotable");
  });

  it("o texto que vai ao agente leva as citações depois do texto e antes dos anexos", () => {
    const composer = read("../ChatComposer.tsx");
    expect(composer).toContain("send(withQuotes(text, quotes), attachments.list)");
    expect(composer).toContain("onQueue(withQuotes(text, quotes), attachments.list)");
    const attach = read("../attachments/send.ts");
    expect(attach).toContain("const context = takeImageContext");
    expect(attach).toContain("withAttachmentBlock(`${text}${context}`, attachments)");
  });
});
