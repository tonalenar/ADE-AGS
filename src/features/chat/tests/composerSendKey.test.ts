import { describe, expect, it } from "vitest";

import { enterKeyAction, isSendShortcut, modifierLabel, type EnterKeyInput, type SendShortcut } from "@/features/chat/composerSendKey";

/** Uma tecla Enter sem nenhum modificador, numa mensagem de uma linha. */
const plain = (shortcut: SendShortcut, over: Partial<EnterKeyInput> = {}): EnterKeyInput => ({
  shortcut, mod: false, shift: false, alt: false, multiline: false, ...over,
});

describe("Enviar com: Enter", () => {
  it("Enter envia, Shift+Enter quebra a linha e Cmd/Ctrl+Enter faz a ação oposta", () => {
    expect(enterKeyAction(plain("enter"))).toBe("default");
    expect(enterKeyAction(plain("enter", { shift: true }))).toBe("newline");
    expect(enterKeyAction(plain("enter", { mod: true }))).toBe("opposite");
  });

  it("o Alt sozinho não muda o Enter; Cmd/Ctrl+Alt+Enter não envia nem quebra a linha", () => {
    expect(enterKeyAction(plain("enter", { alt: true }))).toBe("default");
    expect(enterKeyAction(plain("enter", { mod: true, alt: true }))).toBe("ignore");
  });

  it("Cmd/Ctrl+Shift+Enter no modo Enter quebra a linha, como antes", () => {
    expect(enterKeyAction(plain("enter", { mod: true, shift: true }))).toBe("newline");
  });

  it("a mensagem com várias linhas não muda o Enter", () => {
    expect(enterKeyAction(plain("enter", { multiline: true }))).toBe("default");
  });
});

describe("Enviar com: Enter só em mensagem de várias linhas (Cmd/Ctrl para as longas)", () => {
  it("numa linha só, o Enter envia", () => {
    expect(enterKeyAction(plain("mod-enter-multiline"))).toBe("default");
  });

  it("numa mensagem com quebra, o Enter quebra a linha e o Cmd/Ctrl+Enter envia", () => {
    expect(enterKeyAction(plain("mod-enter-multiline", { multiline: true }))).toBe("newline");
    expect(enterKeyAction(plain("mod-enter-multiline", { multiline: true, mod: true }))).toBe("default");
  });

  it("Cmd/Ctrl+Shift+Enter faz a ação oposta, e o Shift sozinho quebra a linha", () => {
    expect(enterKeyAction(plain("mod-enter-multiline", { mod: true, shift: true }))).toBe("opposite");
    expect(enterKeyAction(plain("mod-enter-multiline", { shift: true }))).toBe("newline");
  });
});

describe("Enviar com: sempre Cmd/Ctrl+Enter", () => {
  it("o Enter nunca envia, em qualquer tamanho de mensagem", () => {
    expect(enterKeyAction(plain("mod-enter"))).toBe("newline");
    expect(enterKeyAction(plain("mod-enter", { multiline: true }))).toBe("newline");
  });

  it("Cmd/Ctrl+Enter envia com a ação padrão; com Shift, a oposta", () => {
    expect(enterKeyAction(plain("mod-enter", { mod: true }))).toBe("default");
    expect(enterKeyAction(plain("mod-enter", { mod: true, shift: true }))).toBe("opposite");
  });

  it("Cmd/Ctrl+Alt+Enter é ignorado, como nos outros modos", () => {
    expect(enterKeyAction(plain("mod-enter", { mod: true, alt: true }))).toBe("ignore");
  });
});

describe("valores salvos de Enviar com", () => {
  it("só os três modos são válidos", () => {
    expect(isSendShortcut("enter")).toBe(true);
    expect(isSendShortcut("mod-enter-multiline")).toBe(true);
    expect(isSendShortcut("mod-enter")).toBe(true);
    expect(isSendShortcut("shift-enter")).toBe(false);
    expect(isSendShortcut(undefined)).toBe(false);
  });
});

describe("nome do modificador na tela", () => {
  it("Cmd no macOS, Ctrl no resto", () => {
    expect(modifierLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("Cmd");
    expect(modifierLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("Cmd");
    expect(modifierLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Ctrl");
    expect(modifierLabel("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl");
  });
});
