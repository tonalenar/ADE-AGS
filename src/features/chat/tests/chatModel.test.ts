import { describe, expect, it } from "vitest";

import { chatCommand, chatProjects, conversationCards, conversationTitle, TITLE_MAX } from "@/features/chat/chatModel";
import type { RepoGroup, WorkspaceNode } from "@/features/workspaces/workspaceTree";

function ws(cwd: string, patch: Partial<WorkspaceNode> = {}): WorkspaceNode {
  return {
    key: cwd, cwd, title: cwd.split("/").pop() ?? cwd, branch: "main", isPrimary: true, isWorktree: false,
    changedCount: 0, agents: [], closed: false, savedAgents: 0, ...patch,
  };
}

const group = (key: string, workspaces: WorkspaceNode[]): RepoGroup => ({ key, name: key, isRepo: true, workspaces, agentCount: 0 });

describe("conversationTitle", () => {
  it("usa a primeira linha com texto, sem espaços repetidos", () => {
    expect(conversationTitle("\n\n  Corrige   o login\nmais detalhes")).toBe("Corrige o login");
  });

  it("encurta prompts longos com reticências", () => {
    const title = conversationTitle("a".repeat(200))!;
    expect(title.length).toBe(TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
  });

  it("prompt vazio não dá título", () => {
    expect(conversationTitle("   \n ")).toBeNull();
  });
});

describe("chatCommand", () => {
  it("Claude recebe permissão, modelo e esforço com os flags das missões", () => {
    expect(chatCommand("claude-code", "claude", { model: "opus", effort: "high", access: "safe" }))
      .toBe("claude --permission-mode auto --model opus --effort high");
  });

  it("supervisionado não acrescenta flag de permissão", () => {
    expect(chatCommand("claude-code", "claude", { model: null, effort: null, access: "ask" })).toBe("claude");
  });

  it("Codex usa -m e o esforço por -c, com o modo normal explícito", () => {
    expect(chatCommand("codex", "codex", { model: "gpt-6.1-sol", effort: "medium", access: "ask" }))
      .toBe("codex -m gpt-6.1-sol -c model_reasoning_effort=medium -c features.fast_mode=false");
  });

  it("um modelo com caracteres de shell não entra no comando", () => {
    expect(chatCommand("claude-code", "claude", { model: "x; rm -rf ~", effort: null, access: "ask" })).toBe("claude");
  });
});

describe("chatProjects", () => {
  it("lista as pastas abertas antes das fechadas, sem repetir", () => {
    const groups = [
      group("r1", [ws("/p/fechado", { closed: true }), ws("/p/aberto")]),
      group("r2", [ws("/p/aberto"), ws("/p/outro", { branch: null })]),
    ];
    expect(chatProjects(groups)).toEqual([
      { cwd: "/p/aberto", name: "aberto", branch: "main" },
      { cwd: "/p/outro", name: "outro", branch: null },
      { cwd: "/p/fechado", name: "fechado", branch: "main" },
    ]);
  });
});

describe("conversationCards", () => {
  const agent = (tabId: string, agentId: string, openedAt: number, status: "starting" | "running" = "running") =>
    ({ tabId, title: `t-${tabId}`, agentId, agentLabel: agentId, status, isActive: false, openedAt });

  it("só agentes de pastas abertas, sem shell, os mais novos primeiro", () => {
    const groups = [group("r", [
      ws("/p/a", { agents: [agent("1", "claude-code", 10), agent("2", "bash", 30), agent("3", "codex", 20, "starting")] }),
      ws("/p/b", { closed: true, agents: [agent("4", "gemini-cli", 99)] }),
    ])];
    const cards = conversationCards(groups);
    expect(cards.map((c) => c.tabId)).toEqual(["3", "1"]);
    expect(cards[0]).toMatchObject({ project: "a", cwd: "/p/a", branch: "main", starting: true });
  });
});
