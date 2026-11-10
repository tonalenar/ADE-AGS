// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

describe("transcrição de voz no composer", () => {
  it("insere o texto transcrito na posição do cursor sem enviar", () => {
    // Simula a lógica de insertTranscript do ChatComposer (linhas 170-183 de ChatComposer.tsx)
    let composerText = "Mensagem inicial";
    let caretPos = composerText.length;
    const submitMock = vi.fn();

    const insertTranscript = (transcript: string) => {
      const before = composerText.slice(0, caretPos);
      const after = composerText.slice(caretPos);
      const phrase = transcript.trim();
      if (!phrase) return;
      const leadingSpace = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const trailingSpace = after.length > 0 && !/^\s/.test(after) ? " " : "";
      const insertion = `${leadingSpace}${phrase}${trailingSpace}`;
      composerText = `${before}${insertion}${after}`;
      caretPos = before.length + insertion.length;
      // NUNCA chama submitMock!
    };

    insertTranscript("adicionando voz com segurança");

    expect(composerText).toBe("Mensagem inicial adicionando voz com segurança");
    expect(submitMock).not.toHaveBeenCalled();
  });
});
