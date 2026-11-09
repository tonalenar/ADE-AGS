import { describe, expect, it } from "vitest";

import { activeToken, COMMANDS, replaceToken } from "../ComposerAssistMenu";

describe("tokens contextuais do composer", () => {
  it("reconhece busca de pull request com # depois de espaço", () => {
    expect(activeToken("revise este #42", 15)).toEqual({ trigger: "#", query: "42", start: 12 });
  });

  it("insere a referência ao pull request no cursor e preserva o restante do texto", () => {
    const text = "Veja #42 e compare";
    const token = activeToken(text, 8)!;
    const inserted = "PR #42: Ajustar login (https://git.example/pr/42) ";
    expect(replaceToken(text, 8, token, inserted))
      .toEqual({ text: `Veja ${inserted} e compare`, caret: 5 + inserted.length });
  });

  it("continua aceitando os gatilhos existentes", () => {
    expect(activeToken("@ton", 4)?.trigger).toBe("@");
    expect(activeToken("/device", 7)?.trigger).toBe("/");
    expect(activeToken("$jev", 4)?.trigger).toBe("$");
  });

  it("expõe no menu do composer as superfícies Terminal e Pull requests da ADE", () => {
    expect(COMMANDS.map((command) => command.id)).toContain("terminal");
    expect(COMMANDS.map((command) => command.id)).toContain("pr");
  });
});
