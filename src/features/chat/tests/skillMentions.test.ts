import { describe, expect, it } from "vitest";

import { dispatchSkillMentions } from "../skillMentions";

describe("dispatchSkillMentions: $nome no envio", () => {
  it("o Claude recebe a menção do meio como /nome no início, com o resto como argumento", () => {
    expect(dispatchSkillMentions("claude-code", "Use $deploy agora", ["deploy"])).toBe("/deploy Use agora");
  });

  it("menção que já abre a mensagem vira /nome e o texto segue", () => {
    expect(dispatchSkillMentions("claude-code", "$deploy agora", ["deploy"])).toBe("/deploy agora");
  });

  it("sem texto depois, sai só o comando", () => {
    expect(dispatchSkillMentions("claude-code", "$deploy", ["deploy"])).toBe("/deploy");
  });

  it("cifrão que não é skill conhecida fica como está", () => {
    expect(dispatchSkillMentions("claude-code", "custa $5 e $foo", ["deploy"])).toBe("custa $5 e $foo");
  });

  it("com duas skills, a última vai para o início e a outra fica como /nome no texto", () => {
    expect(dispatchSkillMentions("claude-code", "$a fazer e $b", ["a", "b"])).toBe("/b /a fazer e");
  });

  it("quebra de linha ao redor da menção é preservada", () => {
    expect(dispatchSkillMentions("claude-code", "Olhe:\n$deploy\nobrigado", ["deploy"])).toBe("/deploy Olhe:\n\nobrigado");
  });

  it("o Codex aceita $nome no próprio texto: nada muda", () => {
    expect(dispatchSkillMentions("codex", "Use $deploy agora", ["deploy"])).toBe("Use $deploy agora");
  });

  it("sem menção, nada muda", () => {
    expect(dispatchSkillMentions("claude-code", "oi", ["deploy"])).toBe("oi");
  });
});
