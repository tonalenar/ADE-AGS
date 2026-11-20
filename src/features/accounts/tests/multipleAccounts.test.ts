import { describe, expect, it } from "vitest";

import { shouldWarnMultipleAccounts } from "@/features/accounts/multipleAccounts";
import type { AgentAccount } from "@/features/accounts/types";

const conta = (over: Partial<AgentAccount>): AgentAccount => ({
  id: "a", agentId: "claude-code", name: "x", dir: "/d", envVar: "X", loginCommand: "x", loggedIn: true, label: null,
  createdAt: 0, kind: "login", baseUrl: null, keyHint: null, ...over,
});

describe("aviso de segunda conta", () => {
  it("avisa ao adicionar a 2ª conta de Claude ou Codex, quando já há uma com login", () => {
    expect(shouldWarnMultipleAccounts("claude-code", [], [conta({ id: "system:claude-code" })])).toBe(true);
    expect(shouldWarnMultipleAccounts("codex", [conta({ id: "c1", agentId: "codex" })], [])).toBe(true);
  });

  it("não avisa na primeira conta, nem quando a existente está sem login", () => {
    expect(shouldWarnMultipleAccounts("claude-code", [], [])).toBe(false);
    expect(shouldWarnMultipleAccounts("claude-code", [], [conta({ id: "system:claude-code", loggedIn: false })])).toBe(false);
  });

  it("só olha as contas do mesmo agente", () => {
    expect(shouldWarnMultipleAccounts("codex", [conta({ id: "c1", agentId: "claude-code" })], [conta({ id: "system:claude-code" })])).toBe(false);
  });

  it("não avisa nos outros agentes", () => {
    expect(shouldWarnMultipleAccounts("opencode", [], [conta({ id: "system:opencode", agentId: "opencode" })])).toBe(false);
    expect(shouldWarnMultipleAccounts("antigravity", [], [conta({ id: "system:antigravity", agentId: "antigravity" })])).toBe(false);
  });
});
