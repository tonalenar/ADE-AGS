import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_PREFS, parseChatPrefs } from "@/features/chat/chatPrefs";
import { isPageRoute } from "@/features/chat/chatRoutes";

describe("parseChatPrefs", () => {
  it("lixo vira o padrão", () => {
    expect(parseChatPrefs(null)).toEqual(DEFAULT_CHAT_PREFS);
    expect(parseChatPrefs("x")).toEqual(DEFAULT_CHAT_PREFS);
  });

  it("guarda só o que serve", () => {
    expect(parseChatPrefs({ cwd: "/p", agentId: "codex", model: 3, effort: "", accountId: "a1", access: "ask", extra: true }))
      .toEqual({ cwd: "/p", agentId: "codex", model: null, effort: null, accountId: "a1", access: "ask", plan: false, worktree: false, structured: true });
  });

  it("permissão desconhecida cai no nível das missões (safe)", () => {
    expect(parseChatPrefs({ access: "root" }).access).toBe("safe");
  });
});

describe("isPageRoute", () => {
  it("a inicial e o workspace são o fundo; o resto é tela cheia", () => {
    expect(isPageRoute("/")).toBe(false);
    expect(isPageRoute("/workspace")).toBe(false);
    expect(isPageRoute("/settings")).toBe(true);
    expect(isPageRoute("/missions")).toBe(true);
  });
});

describe("parseChatPrefs: conversa por protocolo", () => {
  it("vem ligada e só desliga com false explícito", () => {
    expect(parseChatPrefs({}).structured).toBe(true);
    expect(parseChatPrefs({ structured: "não" }).structured).toBe(true);
    expect(parseChatPrefs({ structured: false }).structured).toBe(false);
  });
});
