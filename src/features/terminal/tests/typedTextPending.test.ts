import { describe, expect, it } from "vitest";

import { typedTextPending } from "../terminalRegistry";

/** Hermes e OpenCode deixam o colado inteiro na caixa (sem "[Pasted …]"): o cursor no fim dele = não enviado. */
describe("typedTextPending", () => {
  const sent = "[ADE AGS] Você é um subagente deste time. O orquestrador vai definir o seu papel e enviar as tarefas: aguarde.";

  it("o texto quebrado em linhas, com o cursor logo depois do fim, ainda não foi enviado", () => {
    const beforeCursor = "❯ [ADE AGS] Você é um subagente deste time. O orquestrador vai definir o seu papel e enviar as" + " tarefas: aguarde.";
    expect(typedTextPending(beforeCursor, sent)).toBe(true);
  });

  it("dentro de uma caixa com bordas também conta", () => {
    expect(typedTextPending("│ > olá, revise o checkout   ││ e rode os testes", "olá, revise o checkout e rode os testes")).toBe(true);
  });

  it("caixa vazia depois do envio, ou com o que a pessoa já digitou: não", () => {
    expect(typedTextPending("❯ ", sent)).toBe(false);
    expect(typedTextPending("❯ tarefas: aguarde. e mais uma coisa", sent)).toBe(false);
    expect(typedTextPending("qualquer coisa", "   ")).toBe(false);
  });
});
