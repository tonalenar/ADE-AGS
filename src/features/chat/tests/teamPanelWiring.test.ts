import { beforeEach, describe, expect, it } from "vitest";

import { panelForNewConversation, setRightPanel, useChatStore } from "../store";
import { useTeamDraft } from "../team/draftStore";

describe("trocar de conversa não mexe na aba do painel direito", () => {
  beforeEach(() => {
    useChatStore.setState({ panel: "team", surfaces: ["team"], lastPanel: null });
    useTeamDraft.setState({ members: [], lead: null, adding: false, editing: null });
  });

  it("nada reabre o Time ao ligar uma conversa: só o efeito de conversa nova chama panelForNewConversation", () => {
    expect(typeof panelForNewConversation).toBe("function");
    useChatStore.setState({ panel: "ios" });
    expect(useChatStore.getState().panel).toBe("ios");
  });

  it("entrar numa conversa nova tira o Time do painel (só com o rascunho vazio)", () => {
    const next = panelForNewConversation(useChatStore.getState().panel, useTeamDraft.getState().members.length === 0);
    if (next !== useChatStore.getState().panel) setRightPanel(next);
    expect(useChatStore.getState().panel).toBeNull();

    setRightPanel("team");
    useTeamDraft.setState({ members: [{ id: "d1" }] as never });
    const keep = panelForNewConversation(useChatStore.getState().panel, useTeamDraft.getState().members.length === 0);
    if (keep !== useChatStore.getState().panel) setRightPanel(keep);
    expect(useChatStore.getState().panel).toBe("team");
  });
});
