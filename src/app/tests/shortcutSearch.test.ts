import { describe, expect, it } from "vitest";

import { normalizeShortcutSearch, shortcutMatches } from "../shortcutSearch";

describe("busca do catálogo de atalhos", () => {
  it("ignora acentos, caixa e espaços duplicados", () => {
    expect(normalizeShortcutSearch("  Próxima   Aba ")).toBe("proxima aba");
    expect(shortcutMatches("Próxima aba", "Ctrl+Tab", "proxima aba")).toBe(true);
  });

  it("também encontra pelo acorde e deixa a lista inteira quando vazio", () => {
    expect(shortcutMatches("Abrir paleta", "Ctrl+Shift+P", "ctrl+shift+p")).toBe(true);
    expect(shortcutMatches("Abrir paleta", "Ctrl+K", "configuração")).toBe(false);
    expect(shortcutMatches("Abrir paleta", "Ctrl+K", "   ")).toBe(true);
  });
});
