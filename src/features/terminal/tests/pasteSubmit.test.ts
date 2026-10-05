import { describe, expect, it } from "vitest";

import { pasteStillPending } from "../terminalRegistry";

describe("pasteStillPending", () => {
  it("detecta o briefing colado e não enviado no Codex", () => {
    expect(pasteStillPending(["", "› [Pasted Content 3904 chars]", "", "  medium · ~\\ADE-AGS"])).toBe(true);
  });

  it("detecta o marcador do Claude Code na caixa de entrada", () => {
    expect(pasteStillPending(["────", "❯ [Pasted text #1 +30 lines]", "────"])).toBe(true);
  });

  it("não reenvia quando a caixa está vazia", () => {
    expect(pasteStillPending(["Resposta do agente", "› ", "  medium · ~\\ADE-AGS"])).toBe(false);
  });

  it("ignora o marcador que ficou só no histórico acima da caixa", () => {
    expect(pasteStillPending(["> [Pasted Content 3904 chars]", "texto", "texto", "texto", "texto", "texto", "texto", "› "])).toBe(false);
  });
});
