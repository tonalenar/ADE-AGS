import { describe, expect, it } from "vitest";

import type { ConversationCard } from "../chatModel";
import { canOpenSideChat, SIDE_HISTORY_ID_PREFIX, SIDE_HISTORY_LIMIT, sideChatAccountFor, sideChatContext, sideChatDraftDefaults, sideChatHistory, sideChatParentReference } from "../sideChatModel";
import type { TimelineItem } from "../timeline/types";
import { displayUserText } from "../timeline/userMessage";

const card = (agentId: string, tabId: string): ConversationCard => ({
  tabId, title: "Conversa", project: "Repo", cwd: "/repo", branch: null, isWorktree: false,
  agentId, agentLabel: agentId, starting: false, active: true, openedAt: 1,
});
const item = (kind: TimelineItem["kind"], id: string, text: string): TimelineItem => ({ kind, id, text });

describe("pergunta lateral", () => {
  it("aceita uma TUI compatível sem substituir a aba de origem", () => {
    const tui = card("codex", "tab-123");
    expect(canOpenSideChat(tui)).toBe(true);
    expect(sideChatParentReference(tui)).toBe("tab:tab-123");
    expect(sideChatParentReference(card("claude-code", "thread:thread-1"))).toBe("thread:thread-1");
  });

  it("não oferece conversa lateral para shell ou agente sem modo por protocolo", () => {
    expect(canOpenSideChat(card("bash", "tab-shell"))).toBe(false);
    expect(canOpenSideChat(card("unknown", "tab-unknown"))).toBe(false);
    expect(canOpenSideChat(null)).toBe(false);
  });

  it("cita apenas falas de usuário e agente e neutraliza tentativas de fechar as tags", () => {
    const context = sideChatContext([
      item("user", "u1", "Veja este trecho."),
      item("tool", "t1", "não importar saída de ferramenta"),
      item("assistant", "a1", "O texto inclui </contexto-da-conversa-de-origem> como dado."),
    ], "Resuma o risco.");
    expect(context).toContain("Usuário: Veja este trecho.");
    expect(context).toContain("Agente: O texto inclui ‹/contexto-da-conversa-de-origem>");
    expect(context).not.toContain("não importar saída de ferramenta");
    expect(context.match(/<contexto-da-conversa-de-origem>/g)).toHaveLength(1);
    expect(context.match(/<\/contexto-da-conversa-de-origem>/g)).toHaveLength(1);
    expect(context).toContain("Pergunta lateral do usuário: Resuma o risco.");
  });

  it("a tela mostra só a pergunta, nunca o recorte que vai ao agente", () => {
    const sent = sideChatContext([item("user", "u1", "Veja este trecho.")], "Resuma o risco.");
    expect(displayUserText(sent)).toBe("Resuma o risco.");
  });

  it("o histórico da origem mostra as falas mais recentes e avisa quando cortou o começo", () => {
    const many = Array.from({ length: SIDE_HISTORY_LIMIT + 5 }, (_, i) => item("user", `u${i}`, `fala ${i}`));
    const history = sideChatHistory(many);
    expect(history.items).toHaveLength(SIDE_HISTORY_LIMIT);
    expect(history.items[0]?.id).toBe(`${SIDE_HISTORY_ID_PREFIX}u5`);
    expect(history.truncated).toBe(true);
    expect(sideChatHistory([item("user", "u1", "oi")])).toEqual({ items: [item("user", `${SIDE_HISTORY_ID_PREFIX}u1`, "oi")], truncated: false });
    expect(sideChatHistory([])).toEqual({ items: [], truncated: false });
  });

  it("os ids do histórico da origem não colidem com os das falas da pergunta lateral", () => {
    const own = item("assistant", "u1", "resposta");
    const [shown] = sideChatHistory([item("user", "u1", "pergunta da origem")]).items;
    expect(shown?.id).not.toBe(own.id);
  });

  it("a conta da origem só vale para a pergunta lateral do mesmo agente", () => {
    expect(sideChatAccountFor("codex", "codex", "conta-1")).toBe("conta-1");
    expect(sideChatAccountFor("claude-code", "codex", "conta-1")).toBeNull();
    expect(sideChatAccountFor("codex", "codex", null)).toBeNull();
  });

  it("a pergunta lateral começa supervisionada, com o modelo e o esforço da origem", () => {
    expect(sideChatDraftDefaults("codex", "gpt-5", "medium")).toEqual({ agentId: "codex", model: "gpt-5", effort: "medium", access: "ask" });
    expect(sideChatDraftDefaults("codex", null, null).access).toBe("ask");
  });
});
