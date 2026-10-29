import { describe, expect, it } from "vitest";

import { mentionFor } from "@/features/chat/ChatComposer";
import { accessModesFor, chatCommand, planSupported, readAccess, withAccess } from "@/features/chat/chatModel";
import { applyApproval, applyLiveState } from "@/features/chat/liveStore";

describe("permissões da conversa", () => {
  it("cada modo vira o flag da CLI", () => {
    expect(withAccess("claude-code", "claude", "edits")).toBe("claude --permission-mode acceptEdits");
    expect(withAccess("claude-code", "claude", "full")).toBe("claude --dangerously-skip-permissions");
    expect(withAccess("codex", "codex", "full")).toBe("codex --dangerously-bypass-approvals-and-sandbox");
    expect(withAccess("gemini-cli", "gemini", "full")).toBe("gemini --yolo");
    expect(withAccess("claude-code", "claude", "ask")).toBe("claude");
  });

  it("o Plano vence a permissão no Claude", () => {
    expect(withAccess("claude-code", "claude", "full", true)).toBe("claude --permission-mode plan");
    expect(planSupported("claude-code")).toBe(true);
    expect(planSupported("codex")).toBe(false);
  });

  it("modo que o agente não tem nunca dá MAIS permissão", () => {
    expect(withAccess("opencode", "opencode", "full")).toBe("opencode");
    expect(withAccess("codex", "codex", "edits")).toBe("codex");
  });

  it("os modos disponíveis por agente", () => {
    expect(accessModesFor("claude-code")).toEqual(["ask", "edits", "safe", "full"]);
    expect(accessModesFor("codex")).toEqual(["ask", "safe", "full"]);
    expect(accessModesFor("opencode")).toEqual(["ask"]);
  });

  it("lê de volta o modo do comando da aba", () => {
    for (const access of ["ask", "edits", "safe", "full"] as const) {
      const command = chatCommand("claude-code", "claude", { model: "opus", effort: null, access });
      expect(readAccess("claude-code", command)).toEqual({ access, plan: false });
    }
    expect(readAccess("claude-code", "claude --permission-mode plan")).toEqual({ access: "ask", plan: true });
  });
});

describe("anexo vira @caminho", () => {
  it("relativo à pasta da conversa, com aspas se tiver espaço", () => {
    expect(mentionFor("/p/app", "/p/app/src/a.ts")).toBe("@src/a.ts");
    expect(mentionFor("/p/app/", "/p/app/docs/meu arquivo.md")).toBe('@"docs/meu arquivo.md"');
    expect(mentionFor("/p/app", "/outro/x.ts")).toBe("@/outro/x.ts");
    expect(mentionFor("C:\\p\\app", "C:\\p\\app\\src\\a.ts")).toBe("@src/a.ts");
  });
});

describe("store ao vivo", () => {
  const empty = { phase: {}, question: {}, awaiting: {} };
  it("fase, pergunta e aprovação por aba", () => {
    const snapshot = { tabId: "a", agentId: "codex", mode: "veto" as const, phase: "working" as const, stale: false, tools: [], question: null, endsWithQuestion: false };
    let s = applyLiveState(empty, snapshot);
    expect(s.phase).toEqual({ a: "working" });
    s = applyApproval(s, { tabId: "a", waiting: true, tool: "rm -rf build" });
    expect(s.awaiting).toEqual({ a: "rm -rf build" });
    s = applyApproval(applyLiveState(s, { tabId: "a", removed: true }), { tabId: "a", waiting: false, tool: "" });
    expect(s).toEqual({ phase: {}, question: {}, awaiting: {} });
  });
});
