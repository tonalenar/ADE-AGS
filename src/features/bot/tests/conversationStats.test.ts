import { describe, expect, it } from "vitest";

import type { ConversationRow } from "@/features/sessions/conversationModel";

import { agoParts, conversationHeadline, conversationSummary, liveTeamOf, recentConversations } from "../conversationStats";

const term = (agentLabel: string, orchestrator = false) => ({ agentId: agentLabel.toLowerCase(), agentLabel, command: agentLabel.toLowerCase(), orchestrator });

const row = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: "c1", workspaceId: "w", projectKey: "p", cwd: "C:/p", title: null, customTitle: null, pinned: false, hidden: false,
  state: "saved", terminals: { terminals: [term("Claude Code", true), term("Codex"), term("Antigravity")], links: [] },
  createdAt: 0, lastActiveAt: 0, ...over,
});

describe("conversationHeadline", () => {
  it("prefere o personalizado, depois o título, depois o padrão", () => {
    expect(conversationHeadline(row({ customTitle: "  Sprint  ", title: "Outro" }))).toBe("Sprint");
    expect(conversationHeadline(row({ customTitle: " ", title: "Contexto" }))).toBe("Contexto");
    expect(conversationHeadline(row({ title: null, customTitle: null }))).toBe("Conversa sem título");
  });
});

describe("conversationSummary", () => {
  it("lista a equipe do snapshot e marca o orquestrador", () => {
    expect(conversationSummary(row())).toBe("3 terminais: Claude Code (orquestrador), Codex, Antigravity");
  });

  it("usa os terminais vivos quando há", () => {
    const live = liveTeamOf([{ id: "a", agentLabel: "Codex" }, { id: "b", agentLabel: "Claude Code" }], ["b"]);
    expect(conversationSummary(row(), live)).toBe("2 terminais: Codex, Claude Code (orquestrador)");
  });

  it("sem terminais diz isso", () => {
    expect(conversationSummary(row({ terminals: [] }))).toBe("sem terminais");
    expect(conversationSummary(row({ terminals: null }), undefined, { terminals: (n) => `${n}`, orchestrator: "o", none: "vazio" })).toBe("vazio");
  });
});

describe("recentConversations", () => {
  it("põe as ativas primeiro, depois a atividade mais recente, e esconde as ocultas", () => {
    const rows = [
      row({ id: "s-old", lastActiveAt: 10 }),
      row({ id: "a-old", state: "active", lastActiveAt: 5 }),
      row({ id: "s-new", lastActiveAt: 90 }),
      row({ id: "a-new", state: "active", lastActiveAt: 50 }),
      row({ id: "hid", hidden: true, state: "active", lastActiveAt: 999 }),
    ];
    expect(recentConversations(rows).map((r) => r.id)).toEqual(["a-new", "a-old", "s-new", "s-old"]);
    expect(rows[0].id).toBe("s-old");
  });

  it("respeita o limite (padrão 12)", () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, lastActiveAt: i }));
    expect(recentConversations(many)).toHaveLength(12);
    expect(recentConversations(many, 3)).toHaveLength(3);
  });
});

describe("agoParts", () => {
  it("escolhe a unidade pelo tamanho da diferença (segundos)", () => {
    expect(agoParts(100, 120)).toEqual({ unit: "now" });
    expect(agoParts(0, 600)).toEqual({ unit: "minutes", n: 10 });
    expect(agoParts(0, 7200)).toEqual({ unit: "hours", n: 2 });
    expect(agoParts(0, 3 * 86_400)).toEqual({ unit: "days", n: 3 });
    expect(agoParts(500, 100)).toEqual({ unit: "now" });
  });
});
