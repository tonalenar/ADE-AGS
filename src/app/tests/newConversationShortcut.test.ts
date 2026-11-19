import { describe, expect, it } from "vitest";

import { newConversationShortcutRoute } from "../newConversationShortcut";

describe("rota do atalho de conversa nova", () => {
  it("mantém a tela do workspace em Abas ou Canvas", () => {
    expect(newConversationShortcutRoute(false, "/workspace")).toBeNull();
  });

  it("abre o workspace quando o atalho vem de uma página de tela cheia", () => {
    expect(newConversationShortcutRoute(false, "/settings")).toBe("/workspace");
  });

  it("abre a conversa nova na casca de chat quando o chat já está ativo", () => {
    expect(newConversationShortcutRoute(true, "/workspace")).toBe("/");
  });
});
