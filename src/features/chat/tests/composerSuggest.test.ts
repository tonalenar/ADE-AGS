import { describe, expect, it } from "vitest";

import { suggestNextPrompt, type SuggestItem } from "../composerSuggest";

const labels = { yes: "Sim, pode fazer.", runTests: "Rode os testes." };
const user: SuggestItem = { kind: "user", text: "faça X" };
const reply = (text: string): SuggestItem => ({ kind: "assistant", text });
const edit: SuggestItem = { kind: "tool", tool: "edit", status: "done" };

describe("suggestNextPrompt", () => {
  it("usa a primeira linha de «Próximos passos»", () => {
    const text = "Pronto.\n\n**Próximos passos:**\n- Atualizar o `README`\n- Abrir o PR";
    expect(suggestNextPrompt([user, reply(text)], labels)).toBe("Atualizar o README");
  });

  it("entende «Next steps» e «Siguientes pasos»", () => {
    expect(suggestNextPrompt([user, reply("Done.\n\nNext steps\n1. Add docs")], labels)).toBe("Add docs");
    expect(suggestNextPrompt([user, reply("Listo.\n## Siguientes pasos\n* Subir el PR")], labels)).toBe("Subir el PR");
  });

  it("uma oferta em pergunta vira «sim»", () => {
    expect(suggestNextPrompt([user, reply("Achei o bug. Quer que eu corrija agora?")], labels)).toBe(labels.yes);
    expect(suggestNextPrompt([user, reply("Found it. Want me to fix it?")], labels)).toBe(labels.yes);
  });

  it("editou arquivos sem falar de testes: pede os testes", () => {
    expect(suggestNextPrompt([user, edit, reply("Alterei o módulo.")], labels)).toBe(labels.runTests);
  });

  it("já falou de testes: não repete o pedido", () => {
    expect(suggestNextPrompt([user, edit, reply("Alterei e os testes passaram.")], labels)).toBeNull();
  });

  it("edição que falhou não conta", () => {
    expect(suggestNextPrompt([user, { kind: "tool", tool: "edit", status: "error" }, reply("Não deu.")], labels)).toBeNull();
  });

  it("só olha o turno atual", () => {
    expect(suggestNextPrompt([user, edit, reply("ok"), { kind: "user", text: "e agora?" }, reply("Tudo certo.")], labels)).toBeNull();
  });

  it("sem resposta do agente, nada", () => {
    expect(suggestNextPrompt([user], labels)).toBeNull();
    expect(suggestNextPrompt([], labels)).toBeNull();
  });
});
